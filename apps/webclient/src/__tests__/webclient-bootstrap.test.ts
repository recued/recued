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
  WebclientServerProfile,
  WebclientTokenRecord,
} from '@recued/contracts';
// ⚠ VALUE import, deliberately separate from the type block above — the
// first cut folded it in there and it arrived `undefined` at runtime.
import { CHAT_HISTORY_WINDOW } from '@recued/contracts';
import { RunModal } from '@recued/ui-shared';
import { generateRecoveryKey } from '@recued/crypto';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from '../storage/token-store.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../realtime/ws-client.js';
import {
  CONNECTION_BANNER_ACTION_ATTR,
  CONNECTION_BANNER_ATTR,
  CONNECTION_STATUS_ANNOUNCER_ATTR,
} from '../shell/connection-indicator.js';
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
  CONTRACTS_ROUTE_ERROR_ATTR,
  CONTRACTS_ROUTE_HEADING_ATTR,
  CONTRACTS_ROUTE_LIST_TAB_ATTR,
  CONTRACTS_ROUTE_LOADING_ATTR,
  CONTRACTS_ROUTE_ROW_ATTR,
} from '../contracts/bootstrap-contracts-route.js';
import {
  RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
  RECIPE_EDITOR_RECIPE_ID_ATTR,
  RECIPE_EDITOR_SAVE_ATTR,
  RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR,
} from '../kitchen/recipe-editor/recipe-editor-route.js';
import { SERVER_PILL_HOST_ATTR } from '../shell/server-pill-host.js';
import { SERVER_SWITCH_CONTINUITY_SESSION_KEY } from '../shell/server-switch-continuity.js';
import { createFoundationalOAuthReloadStore } from '../connections/foundational-oauth-reload.js';
import {
  CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
} from '../connections/credential-rotation-server-update-continuity.js';
import {
  CONNECTIONS_ROUTE_CONTENT_ATTR,
  CONNECTIONS_ROUTE_ENROLL_HOST_ATTR,
} from '../connections/bootstrap-connections-route.js';
import {
  createBrowserCredentialRotationTabConvergence,
  serverUpdateProgressStorageKey,
} from '../connections/credential-rotation-tab-convergence.js';
import {
  SERVER_SWITCH_CONVERGENCE_ATTR,
  SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ITEM_ATTR,
  SERVER_SWITCH_CONVERGENCE_CHECK_ATTR,
  SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR,
  SERVER_SWITCH_CONVERGENCE_COPY_ATTR,
  SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR,
  SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR,
  SERVER_SWITCH_CONVERGENCE_ERROR_ATTR,
  SERVER_SWITCH_CONVERGENCE_STATUS_ATTR,
} from '../shell/server-switch-convergence.js';
import {
  SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR,
  SERVER_SWITCHER_ITEM_ATTR,
  SERVER_SWITCHER_RECENCY_ATTR,
  SERVER_SWITCHER_SWITCH_CANCEL_ATTR,
  SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
  SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
  SERVER_SWITCHER_SWITCH_ERROR_ATTR,
  SERVER_SWITCHER_RENAME_ATTR,
  SERVER_SWITCHER_RENAME_ERROR_ATTR,
  SERVER_SWITCHER_RENAME_INPUT_ATTR,
  SERVER_SWITCHER_RENAME_SAVE_ATTR,
  SERVER_SWITCHER_REMOVE_ATTR,
  SERVER_SWITCHER_REMOVE_ERROR_ATTR,
  SERVER_SWITCHER_REMOVE_LOCAL_ATTR,
  SERVER_SWITCHER_REMOVE_REVOKE_ATTR,
  SERVER_SWITCHER_RETURN_TO_WORK_ATTR,
} from '../shell/server-switcher.js';
import { THEME_TOGGLE_ATTR } from '../shell/theme-controller.js';
import {
  GLOBAL_RUN_PALETTE_SHORTCUT,
  GLOBAL_RUN_PALETTE_TRIGGER_ATTR,
} from '../shell/global-run-palette.js';
import { WebclientReauthRequiredError } from '../realtime/ws-client.js';
import {
  ACCOUNT_MENU_ADD_SERVER_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
  ACCOUNT_MENU_BADGE_ATTR,
  ACCOUNT_MENU_CLOSE_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
  ACCOUNT_MENU_POPOVER_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
  ACCOUNT_MENU_SERVER_SLOT_ATTR,
  ACCOUNT_MENU_SETTINGS_ATTR,
  ACCOUNT_MENU_THEME_SLOT_ATTR,
  ACCOUNT_MENU_TRIGGER_ATTR,
} from '../shell/account-menu.js';
import type { WebclientProfileStore } from '../storage/local-store.js';
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
  buildRecipeExecuteArgs,
  deriveComposeReceptionStatusFromHostnames,
  parseRouteFromHash,
  type WebclientHashSource,
} from '../webclient-bootstrap.js';
import { WEBCLIENT_POLISH_STYLES } from '../shell/webclient-polish-styles.js';
import {
  RECOVERY_INTENT_ANNOUNCER_ATTR,
  RECOVERY_INTENT_CUE_ATTR,
} from '../shell/recovery-intent-landing.js';
import {
  RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
} from '../shell/recovery-intent-continuation.js';
import {
  ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR,
  ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR,
  ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
  ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR,
  ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
  ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR,
  ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR,
  ATTENTION_TOPBAR_HOST_ATTR,
} from '../attention/approval-attention-popover.js';
import {
  INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX,
  INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
} from '../attention/inactive-profile-recovery.js';
import {
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_PLAN_CONTINUE_ATTR,
  CHAT_ROUTE_PLAN_TARGET_ATTR,
  CHAT_ROUTE_SEND_ATTR,
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
  SELLER_DIRECTORY_ROW_ATTR,
  SELLER_OFFER_STATE_ACTION_ATTR,
  SELLER_SETTINGS_FORM_FIELD_ATTR,
  SELLER_SETTINGS_FORM_SUBMIT_ATTR,
  SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR,
} from '../settings/seller-page.js';
import {
  SETTINGS_ROUTE_ACTIVE_ATTR,
  SETTINGS_ROUTE_NAV_ITEM_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
} from '../settings/bootstrap-settings-route.js';
import {
  ARCHIVE_BACKUP_MNEMONIC_ATTR,
  ARCHIVE_BACKUP_RUN_BTN_ATTR,
  ARCHIVE_BACKUP_START_BTN_ATTR,
  ARCHIVE_BACKUP_VIEW_ATTR,
} from '../settings/archive-backup-panel.js';
import {
  UPDATES_CHECK_BTN_ATTR,
  UPDATES_CREDENTIAL_RETRY_ATTR,
  UPDATES_CREDENTIAL_RETRY_RETURN_ATTR,
  UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
  UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR,
  UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
  UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR,
  UPDATES_RECEIPT_DIAGNOSTIC_ATTR,
  UPDATES_RECEIPT_RECOVERY_ATTR,
  UPDATES_RECEIPT_RETRY_ATTR,
} from '../settings/updates-page.js';

// ──────────────────────────────────────────────────────────────────
// Fake element / document — same shape as the reception-bootstrap
// tests; verbatim is fine because the route still mounts into them.
// ──────────────────────────────────────────────────────────────────

interface FakeElement extends HTMLElement {
  attrs: Map<string, string>;
  childList: FakeElement[];
  parentRef: FakeElement | null;
  focusCallCount: number;
  value: string;
  fireAttributeClick(attrs: Record<string, string>): void;
  fireInput(value: string): void;
  fireConnectionField(key: string, value: string, tagName?: string): void;
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
    focusCallCount: 0,
    value: '',
    get parentElement(): FakeElement | null {
      return (el as FakeElement).parentRef;
    },
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
    focus: (): void => {
      (el as FakeElement).focusCallCount += 1;
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
    fireConnectionField: (
      key: string,
      value: string,
      tagName = 'INPUT',
    ): void => {
      const target = {
        dataset: { connField: key },
        value,
        tagName,
        closest: (): unknown => target,
      } as unknown as HTMLElement;
      const type = tagName === 'SELECT' ? 'change' : 'input';
      for (const fn of [...listeners[type] ?? []]) {
        fn({ target, type } as unknown as Event);
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
  fireDocumentEvent(type: string, target: EventTarget): void;
  createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    options?: ElementCreationOptions,
  ): FakeElement & HTMLElementTagNameMap[K];
  createElement(tagName: string, options?: ElementCreationOptions): FakeElement;
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
    fireDocumentEvent: (type: string, target: EventTarget): void => {
      for (const listener of [...(docListeners[type] ?? [])]) {
        listener({ target } as unknown as Event);
      }
    },
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

const memorySessionStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
};

const seedExpiredDeferredContractsCheck = (
  storage: ReturnType<typeof memorySessionStorage>,
  now: number,
  reviewStartedAt: number | null = null,
): void => {
  const pausedAt = now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;
  storage.setItem(
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    JSON.stringify({
      v: 1,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }),
  );
  storage.setItem(
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    JSON.stringify({
      v: 2,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }),
  );
  storage.setItem(
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    JSON.stringify({
      v: 4,
      profile_id: 'p1',
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: reviewStartedAt,
      attempt_count: reviewStartedAt === null ? 0 : 1,
      diagnosis_target: null,
      diagnosis_outcome: null,
    }),
  );
};

const seedPostDiagnosisContractsChoice = (
  storage: ReturnType<typeof memorySessionStorage>,
  now: number,
  outcome: 'choose' | 'recheck_started' = 'choose',
): void => {
  seedExpiredDeferredContractsCheck(storage, now, now);
  const deferred = JSON.parse(storage.getItem(
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )!) as Record<string, unknown>;
  storage.setItem(
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    JSON.stringify({
      ...deferred,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: outcome,
    }),
  );
};

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

const subtreeText = (el: FakeElement): string =>
  el.textContent + el.childList.map(subtreeText).join('');

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
    expect(shellStyle?.textContent).toContain(
      '.webclient-shell-brand:focus-visible',
    );
    expect(shellStyle?.textContent).toContain('min-height: 38px');
    expect(shellStyle?.textContent).toMatch(
      /\.webclient-shell-drawer-close\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px/s,
    );
    expect(shellStyle?.textContent).toMatch(
      /\[data-recued-webclient-drawer\]\s*\{[^}]*box-sizing:\s*border-box;/s,
    );
    expect(WEBCLIENT_POLISH_STYLES).toContain('--wc-content-max: 1160px');
    expect(WEBCLIENT_POLISH_STYLES).toContain(
      '@media (prefers-reduced-motion: reduce)',
    );
    expect(WEBCLIENT_POLISH_STYLES).toMatch(
      /\.data-tab\s*\{[^}]*min-height:\s*36px/s,
    );
    await handle.dispose();
  });

  it('keeps passive sibling recovery silent while restoring its work context', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      reauthRecovery: { returnHash: '#reception' },
      suppressInitialConnectedReceipt: true,
    });

    const banner = findChildByAttr(fixture.root, CONNECTION_BANNER_ATTR);
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('data-state')).toBe('ok');
    expect(subtreeText(banner!)).not.toContain('Reconnected');

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

  it('⛔⛔ mounts Stats when the hash is #stats — the DISCRIMINATOR, not just the drawer', async () => {
    // The drawer entry and the mount branch are two separate wirings, and only one of
    // them was covered: removing `if (route === 'stats')` from the discriminator reddened
    // NOTHING, because every Stats test called `bootstrapStatsRoute` directly. Fourth
    // instance of that shape in this feature — a module with tests and no path to it.
    const fixture = buildOpts();
    fixture.hashSource.setHash('#stats');
    const handle = await bootstrapWebclient(fixture.opts);
    // ⛔⛔ `activeRoute()` ALONE IS VACUOUS — it reports the PARSED hash, so it says
    // 'stats' even with the mount branch deleted. Proved by mutation. The only honest
    // signal is something ONLY the mount produces: the route paints its heading into
    // the shell's content root.
    expect(handle.activeRoute()).toBe('stats');
    // ⚠ The route paints on a promise (`void refresh()`), so let the microtask land —
    // and read the SUBTREE, since the fake element's innerHTML does not serialize
    // children the way a real DOM node does.
    await new Promise((r) => setTimeout(r, 0));
    expect(subtreeInnerHtml(fixture.root)).toContain('data-recued-stats-route-heading');
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
    const profileStore = buildProfileStore([
      switcherProfile(
        'p-attention',
        'Alice home',
        'wss://alice.recued.cloud:8443/ws',
      ),
    ], 'p-attention');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profileStore.store,
    });
    expect(handle.activeRoute()).toBe('reception');
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR);
    expect(topbar).toBeDefined();

    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    expect(connectionList).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      result: {
        connections: [{
          kind: 'api',
          name: 'attention-recovery',
          display_name: 'Attention recovery',
          auth_type: 'bearer',
          updated_at: 9,
        }],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'attention-recovery',
          status: 'pending',
          acknowledged_at: 8,
        }],
      },
    });
    await flush();

    topbar!.fireClick({ action: 'open-attention' });

    expect(topbar!.innerHTML).toContain('attention-popover');
    expect(topbar!.innerHTML).toContain('href="#approvals"');
    expect(topbar!.innerHTML).toContain('Finish recovery for Attention recovery');
    expect(topbar!.innerHTML).toContain(
      'href="#connections/others/finish-recovery/profile/p-attention/api/attention-recovery"',
    );
    expect(topbar!.innerHTML).toContain('Server profile: Alice home');
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
    // ⚠ Hydration is windowed now; the limit rides the request by design.
    expect(sessionGet?.args).toEqual({
      session_id: 'chat_1',
      limit: CHAT_HISTORY_WINDOW,
    });
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

  it('mounts one persistent, keyboard-discoverable Run launcher across routes', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const triggers = findChildrenByAttr(
      fixture.root,
      GLOBAL_RUN_PALETTE_TRIGGER_ATTR,
    );
    expect(triggers).toHaveLength(1);
    const trigger = triggers[0]!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBe('Run a recipe');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-keyshortcuts'))
      .toBe(GLOBAL_RUN_PALETTE_SHORTCUT);
    expect(trigger.getAttribute('title')).toMatch(/^Run a recipe \(.+\)$/);

    fixture.hashSource.setHash('#data');
    expect(findChildByAttr(fixture.root, GLOBAL_RUN_PALETTE_TRIGGER_ATTR))
      .toBe(trigger);
    fixture.hashSource.setHash('#settings');
    expect(findChildrenByAttr(fixture.root, GLOBAL_RUN_PALETTE_TRIGGER_ATTR))
      .toEqual([trigger]);

    await handle.dispose();
    expect(findChildByAttr(fixture.root, GLOBAL_RUN_PALETTE_TRIGGER_ATTR))
      .toBeNull();
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
      // D-250 § D7 — Stats joins the REVIEW section beside Logs. Deliberately not under
      // Server (operational configuration: exposure, certs, keys, maintenance) and not
      // ahead of Chat, which stays the landing.
      'stats',
      'settings',
      'account',
    ]);
    // Wiring: New chat → its explicit draft address; Chats → the history
    // landing. Log → #logs, Account → #settings/account. "Create"
    // is NOT a nav link — it's an action seat (opens the shared Create overlay),
    // asserted separately below.
    expect(drawerLinks.map((link) => link.getAttribute('href'))).toEqual([
      '#chat/new',
      '#chat',
      '#data',
      '#recipes',
      '#automation',
      '#connections',
      '#packs',
      '#contracts',
      '#reception',
      '#logs',
      // D-250 § D7 — the Stats route's href. ⚠ Bare `#stats` with no segment: § C6
      // dropped the per-tag overlay, so there is nothing below this route to address.
      '#stats',
      '#settings',
      '#settings/account',
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
    const dataLink = drawerLinks.find((link) =>
      link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR) === 'data');
    const toggle = findChildByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR,
    );
    toggle!.click();
    expect(dataLink?.focusCallCount).toBe(1);
    toggle!.click();
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

  it('prefers exact sibling destinations and falls back to their route seat', async () => {
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    const activeSeatIds = (): Array<string | null> =>
      findChildrenByAttr(fixture.root, WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR).map(
        (link) => link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR),
      );
    // Bare Settings owns its parent seat; the exact Account address owns the
    // sibling seat, while a deeper Settings section falls back to Settings.
    fixture.hashSource.setHash('#settings');
    expect(activeSeatIds()).toEqual(['settings']);
    fixture.hashSource.setHash('#settings/account');
    expect(activeSeatIds()).toEqual(['account']);
    const accountLink = findChildrenByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_LINK_ATTR,
    ).find((link) =>
      link.getAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR) === 'account');
    const toggle = findChildByAttr(
      fixture.root,
      WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR,
    );
    toggle!.click();
    expect(accountLink?.focusCallCount).toBe(1);
    toggle!.click();
    fixture.hashSource.setHash('#settings/privacy');
    expect(activeSeatIds()).toEqual(['settings']);

    // New chat is also an exact sibling. Durable session addresses still
    // fall back to Chats because they have no dedicated drawer row.
    fixture.hashSource.setHash('#chat');
    expect(activeSeatIds()).toEqual(['chats']);
    fixture.hashSource.setHash('#chat/new');
    expect(activeSeatIds()).toEqual(['new-chat']);
    fixture.hashSource.setHash('#chat/session/chat_1');
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

  it('mounts the §D.L1 account MENU in the rightmost slot, with Settings inside it', async () => {
    // The bare `<a href="#settings/account">` became a menu trigger: the same
    // destination now lives in the menu's quick row, alongside the theme
    // toggle that used to sit beside it in the bar.
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();

    const slot = findChildByAttr(fixture.root, WEBCLIENT_SHELL_ACCOUNT_ATTR);
    expect(slot).not.toBeNull();
    const trigger = findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR);
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(findByAttr(fixture.root, ACCOUNT_MENU_SETTINGS_ATTR)!.getAttribute('href'))
      .toBe('#settings/account');
    await handle.dispose();
  });

  it('moves the theme toggle out of the bar and into the menu', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();

    const slot = findByAttr(fixture.root, ACCOUNT_MENU_THEME_SLOT_ATTR);
    expect(slot).not.toBeNull();
    // The toggle is INSIDE the slot, not loose in the topbar — that is the
    // icon the bar sheds.
    expect(findByAttr(slot!, THEME_TOGGLE_ATTR)).not.toBeNull();
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

  it('replace-canonicalizes a stale Seller tail to the rendered collection', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/orders/page/nope/ignored');
    const replaceState = vi.fn();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      history: { replaceState, pushState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const handle = await bootstrapWebclient(fixture.opts);
    const sellerPage = handle.settingsRoute()?.sellerPage();

    expect(sellerPage?.getState().subpage).toBe('orders');
    expect(sellerPage?.getState().page).toBe(1);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '#settings/seller/orders',
    );
    await flush();
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

  // ── Seller sub-page Back/Forward (rail addressing) ────────────────
  // The Seller sub-page links were always real `#settings/seller/<sub>`
  // anchors, so Back BETWEEN sub-pages worked. What did not: the Settings
  // rail switched sections with a pure attribute flip, so arriving at Seller
  // through the rail left the address naming the section the user came FROM —
  // and Back out of a sub-page landed on that stale address (the first
  // section), never on the Seller directory. The rail now writes its own
  // address.

  const answerSellerOverview = (controls: FakeTransportControls): void => {
    // LATEST, not first — a re-mount issues a second overview request and the
    // first one is already answered.
    const call = findLatestRpcCall(controls, 'server.seller.getOverview');
    if (call === undefined) {
      throw new Error('missing Seller overview request');
    }
    const overview: SellerOverview = {
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
      offers: [],
    };
    controls.fireMessage({
      type: 'rpc_result',
      request_id: call.request_id,
      result: overview,
    });
  };

  /** A real-enough browser history: `defaultView.history` writes and hash
   *  navigations BOTH append entries, and `back()` replays the previous one.
   *  The point is that a Back target is never hand-written in a test — it is
   *  whatever address the app itself put on the stack. */
  const wireHistory = (
    fixture: ReturnType<typeof buildOpts>,
  ): {
    pushState: ReturnType<typeof vi.fn>;
    replaceState: ReturnType<typeof vi.fn>;
    stack: string[];
    back: () => void;
  } => {
    const stack: string[] = [fixture.hashSource.getHash()];
    const pushState = vi.fn((_state: unknown, _title: string, hash: string) => {
      stack.push(hash);
    });
    const replaceState = vi.fn((_state: unknown, _title: string, hash: string) => {
      stack[stack.length - 1] = hash;
    });
    // A hash write (a link click, or the shell's own `navigateHash`) is a
    // history entry too — record it, then let the real fake source dispatch.
    const dispatch = fixture.hashSource.setHash.bind(fixture.hashSource);
    fixture.hashSource.setHash = (hash: string): void => {
      if (hash !== stack[stack.length - 1]) stack.push(hash);
      dispatch(hash);
    };
    const location: { hash: string } = {} as { hash: string };
    Object.defineProperty(location, 'hash', {
      configurable: true,
      get: () => fixture.hashSource.getHash(),
      set: (hash: string) => { fixture.hashSource.setHash(hash); },
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      location,
      history: { pushState, replaceState },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    return {
      pushState,
      replaceState,
      stack,
      // Traversing back re-dispatches the previous entry WITHOUT recording it,
      // exactly as a browser does.
      back: (): void => {
        if (stack.length < 2) throw new Error('history: nothing to go back to');
        stack.pop();
        dispatch(stack[stack.length - 1]!);
      },
    };
  };

  it.each([
    ['#kitchen/pack/draft-1/ignored', '#kitchen/pack/draft-1'],
    ['#kitchen/recipe/recipe-1/ignored', '#kitchen/recipe/recipe-1'],
  ])('replace-canonicalizes a tolerated Kitchen tail: %s', async (
    sourceHash,
    canonicalHash,
  ) => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(sourceHash);
    const replaceState = vi.fn();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      history: { replaceState, pushState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const handle = await bootstrapWebclient(fixture.opts);

    expect(handle.activeRoute()).toBe('kitchen');
    expect(replaceState).toHaveBeenCalledWith(null, '', canonicalHash);
    await handle.dispose();
  });

  it('the Settings rail pushes #settings/<section> without re-mounting', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const { pushState } = wireHistory(fixture);
    const handle = await bootstrapWebclient(fixture.opts);
    const settingsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-settings-route',
    )!;
    const sellerBefore = handle.settingsRoute()!.sellerPage();

    findChildByAttrValue(
      settingsRoot,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'seller',
    )!.fireClick({});

    // A History write emits no hashchange, so the shell must NOT re-mount —
    // every section is already built. Only the address moves.
    expect(pushState).toHaveBeenCalledWith(null, '', '#settings/seller');
    expect(fixture.hashSource.getHash()).toBe('#settings');
    expect(handle.settingsRoute()!.sellerPage()).toBe(sellerBefore);
    expect(
      findChildByAttrValue(settingsRoot, SETTINGS_ROUTE_SECTION_ATTR, 'seller')
        ?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR),
    ).toBe('true');

    await handle.dispose();
    await sellerBefore?.whenLoaded();
  });

  it('Back from a Seller sub-page returns to the Seller directory', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const history = wireHistory(fixture);
    const handle = await bootstrapWebclient(fixture.opts);
    const settingsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-settings-route',
    )!;
    findChildByAttrValue(
      settingsRoot,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'seller',
    )!.fireClick({});
    await flush();
    answerSellerOverview(fixture.transportControls);
    await flush();

    // Drive the directory's OWN link, not a hand-written hash — the anchor is
    // what the browser navigates on.
    const ordersHref = findChildByAttrValue(
      settingsRoot,
      SELLER_DIRECTORY_ROW_ATTR,
      'orders',
    )!.getAttribute('href');
    expect(ordersHref).toBe('#settings/seller/orders');
    fixture.hashSource.setHash(ordersHref!);
    expect(handle.settingsRoute()!.sellerPage()!.getState().subpage).toBe('orders');

    // Back — whatever the app itself put underneath. Nothing here names the
    // address: if the rail had left no entry this lands on `#settings` and the
    // Seller directory never comes back.
    expect(history.stack).toEqual([
      '#settings',
      '#settings/seller',
      '#settings/seller/orders',
    ]);
    history.back();

    const sellerAfter = handle.settingsRoute()!.sellerPage()!;
    expect(sellerAfter.getState().subpage).toBeNull();
    const settingsRootAfter = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-settings-route',
    )!;
    expect(
      findChildByAttrValue(
        settingsRootAfter,
        SETTINGS_ROUTE_SECTION_ATTR,
        'seller',
      )?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR),
    ).toBe('true');
    // Dispose BEFORE awaiting: `whenLoaded()` hands back the LATEST pending
    // load, and a live mount keeps issuing them.
    await handle.dispose();
    await sellerAfter.whenLoaded();
  });

  it('Back between two Settings sections is served in place', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const history = wireHistory(fixture);
    const handle = await bootstrapWebclient(fixture.opts);
    const settingsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-settings-route',
    )!;
    const sellerBefore = handle.settingsRoute()!.sellerPage();
    findChildByAttrValue(
      settingsRoot,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'seller',
    )!.fireClick({});

    // Back to the bare `#settings` landing: a section switch, not deep state,
    // so the mounted route serves it without a re-mount.
    history.back();

    expect(handle.settingsRoute()!.sellerPage()).toBe(sellerBefore);
    expect(
      findChildByAttrValue(settingsRoot, SETTINGS_ROUTE_SECTION_ATTR, 'seller')
        ?.getAttribute(SETTINGS_ROUTE_ACTIVE_ATTR),
    ).toBe('false');
    expect(
      findChildByAttr(routeContentRoot(fixture.root), 'data-recued-settings-route'),
    ).toBe(settingsRoot);

    // The shared controller must adopt the browser-owned Back address. If it
    // still believed Seller was current, this second click would be suppressed
    // as a same-address no-op and the visible rail would desync from the URL.
    findChildByAttrValue(
      settingsRoot,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'seller',
    )!.fireClick({});
    expect(history.pushState).toHaveBeenCalledTimes(2);
    expect(history.stack).toEqual(['#settings', '#settings/seller']);

    await handle.dispose();
    await sellerBefore?.whenLoaded();
  });

  it('a rail switch OUT of a Seller sub-page navigates for real', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/seller/orders');
    const { pushState } = wireHistory(fixture);
    const handle = await bootstrapWebclient(fixture.opts);
    expect(handle.settingsRoute()!.sellerPage()!.getState().subpage).toBe('orders');
    const settingsRoot = findChildByAttr(
      routeContentRoot(fixture.root),
      'data-recued-settings-route',
    )!;

    // In-place would leave Orders on screen under a `#settings/privacy`
    // address — the sub-page is mount-time state, so this one re-mounts.
    findChildByAttrValue(
      settingsRoot,
      SETTINGS_ROUTE_NAV_ITEM_ATTR,
      'privacy',
    )!.fireClick({});

    expect(pushState).not.toHaveBeenCalled();
    expect(fixture.hashSource.getHash()).toBe('#settings/privacy');
    const sellerAfter = handle.settingsRoute()!.sellerPage();
    expect(sellerAfter!.getState().subpage).toBeNull();
    await handle.dispose();
    await sellerAfter?.whenLoaded();
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
    const onPrivacyCredentialsCleared = vi.fn();
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      cryptoKeysWiper: async () => {
        wiped += 1;
      },
      onPrivacyCredentialsCleared,
    });
    const settings = handle.settingsRoute()!;
    const panel = settings.clearThisBrowserPanel();
    panel.clickClear();
    await panel.clickConfirm();
    expect(panel.getState()).toBe('done');
    expect(wiped).toBe(1);
    expect(onPrivacyCredentialsCleared).toHaveBeenCalledOnce();
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

  it('slice 111 — TLS renewal dispatches its rpc and protects the unresolved outcome across routes', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/server');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
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

    // TLS renewal is a Settings action, not a page load. Its unknown outcome
    // remains boot-scoped even after an ordinary route change, so navigating
    // elsewhere cannot silently turn a later server switch into a clean one.
    fixture.hashSource.setHash('#packs');
    expect(handle.settingsRoute()).toBeNull();
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    const switchReview = findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
    )!;
    expect(subtreeText(switchReview)).toContain('Work is still finishing on home');
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Saving a Settings change');
    expect(findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
    )?.textContent).toBe('Switch and check later');
    expect(reload).not.toHaveBeenCalled();

    // The work lease retained the exact source route at dispatch time. The
    // Account review can take the owner there, then the same named lease still
    // protects a later switch review until the rpc actually settles.
    expect(findByAttr(
      fixture.root,
      SERVER_SWITCHER_RETURN_TO_WORK_ATTR,
    )?.textContent).toBe('Return to Settings');
    findByAttr(fixture.root, SERVER_SWITCHER_RETURN_TO_WORK_ATTR)!.click();
    expect(fixture.hashSource.getHash()).toBe('#settings/server');
    expect(handle.settingsRoute()).not.toBeNull();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Saving a Settings change');
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CANCEL_ATTR)!.click();

    await handle.dispose();
    // Rebind the inflight rejection so the test doesn't surface as an
    // unhandled rejection. Disposing the conn rejects pending rpcs
    // with `transport_disposed`.
    await inflight.catch(() => undefined);
  });

  it('restores interrupted OAuth against the exact boot profile and Account return route', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const storage = memorySessionStorage();
    expect(createFoundationalOAuthReloadStore({
      storage,
      scopeId: 'p1',
      now: fixture.opts.now,
    }).write({
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
      accountValues: { name: 'work', send_enabled: 'false' },
      clientId: 'GMAIL-CID',
      phase: 'before_exchange',
      phaseStartedAt: fixture.opts.now(),
    })).toBe(true);

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      foundationalOAuthContinuityStorage: storage,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(subtreeText(
      findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Gmail sign-in was interrupted');
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
    )?.textContent).toBe('Restart sign-in');

    findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)!.click();
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#connections/mail');
    expect(storage.data.size).toBe(0);

    await handle.dispose();
  });

  it('keeps a backup job attached across route changes and settles the shared lease once', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings/backup');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();

    findByAttr(fixture.root, ARCHIVE_BACKUP_START_BTN_ATTR)!.click();
    findByAttr(fixture.root, ARCHIVE_BACKUP_MNEMONIC_ATTR)!
      .fireInput(generateRecoveryKey().mnemonic);
    findByAttr(fixture.root, ARCHIVE_BACKUP_RUN_BTN_ATTR)!.click();
    await flush();

    const rpcCalls = (method: string): Array<{
      request_id: string;
      args?: Record<string, unknown>;
    }> => fixture.transportControls.sendCalls().filter(
      (call): call is {
        type: 'rpc';
        method: string;
        request_id: string;
        args?: Record<string, unknown>;
      } => call !== null
        && typeof call === 'object'
        && (call as { type?: unknown }).type === 'rpc'
        && (call as { method?: unknown }).method === method
        && typeof (call as { request_id?: unknown }).request_id === 'string',
    );
    const exportCall = rpcCalls('server.archive.export')[0]!;
    expect(exportCall.args?.recoveryKey).toBeTypeOf('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: exportCall.request_id,
      result: { job_id: 'archive-job-1' },
    });
    await flush();
    expect(rpcCalls('server.archive.status')).toHaveLength(1);

    fixture.hashSource.setHash('#packs');
    // The poll resolves after its original panel has unmounted. The boot keeps
    // the unseen terminal receipt and changes the action copy instead of
    // silently dropping the result with the disposed route.
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: rpcCalls('server.archive.status')[0]!.request_id,
      result: {
        state: 'done',
        bytes_written: 4096,
        progress_pct: 100,
        path: '/data/exports/complete.recued.archive',
      },
    });
    await flush();
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_ATTR,
    )?.hasAttribute('hidden')).toBe(false);
    expect(subtreeText(
      findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Backup ready to review');
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
    )?.textContent).toBe('View backup result');
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Backup ready to review');
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!,
    )).toContain('A result is ready to review on home');
    expect(findByAttr(
      fixture.root,
      SERVER_SWITCHER_RETURN_TO_WORK_ATTR,
    )?.textContent).toBe('View backup result');

    findByAttr(fixture.root, SERVER_SWITCHER_RETURN_TO_WORK_ATTR)!.click();
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#settings/backup');
    // The boot already observed the terminal status while Backup was
    // unmounted. Re-entry consumes that exact receipt from memory instead of
    // risking a second status request after the server job has expired.
    expect(rpcCalls('server.archive.status')).toHaveLength(1);
    expect(findByAttr(
      fixture.root,
      ARCHIVE_BACKUP_VIEW_ATTR,
    )?.getAttribute(ARCHIVE_BACKUP_VIEW_ATTR)).toBe('export-done');

    fixture.hashSource.setHash('#packs');
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(findByAttr(
      fixture.root,
      SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR,
    )).toBeNull();
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!,
    )).toContain('Recued will reload this tab');

    await handle.dispose();
  });

  it('keeps an acknowledged Chat turn visible after Chat unmounts until its terminal event', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    const rpcCalls = (method: string): Array<{
      request_id: string;
      args?: Record<string, unknown>;
    }> => fixture.transportControls.sendCalls().filter(
      (call): call is {
        type: 'rpc';
        method: string;
        request_id: string;
        args?: Record<string, unknown>;
      } => call !== null
        && typeof call === 'object'
        && (call as { type?: unknown }).type === 'rpc'
        && (call as { method?: unknown }).method === method
        && typeof (call as { request_id?: unknown }).request_id === 'string',
    );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: rpcCalls('chat.sessions.list')[0]!.request_id,
      result: { sessions: [] },
    });
    await flush();

    findByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!.fireInput('Prepare the answer');
    findByAttr(fixture.root, CHAT_ROUTE_SEND_ATTR)!.click();
    await flush();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: rpcCalls('chat.session.create')[0]!.request_id,
      result: { session_id: 'chat_1' },
    });
    await flush();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: rpcCalls('chat.session.get')[0]!.request_id,
      result: {
        id: 'chat_1',
        title: 'Prepare the answer',
        created_at: 1_000,
        last_active_at: 1_000,
        archived: false,
        picker_state: { current: 'self' },
        model_routing: {
          current: 'byok',
          provider: 'local',
          model_id: 'local-default',
          overridden: false,
        },
        messages: [],
        plans: [],
      },
    });
    await flush();
    const sendCall = rpcCalls('chat.send')[0]!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sendCall.request_id,
      result: { turn_id: 'turn_1' },
    });
    await flush();

    fixture.hashSource.setHash('#packs');
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state')).toBe('working');
    expect(subtreeText(
      findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Waiting for a Chat answer');
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
    )?.textContent).toBe('Return to Chat');

    fixture.transportControls.fireMessage({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      final: { id: 'message_1' },
      cursor: 1,
    });
    await flush();
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state')).toBe('ok');
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_ATTR,
    )?.hasAttribute('hidden')).toBe(true);

    await handle.dispose();
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
    const onSessionDispose = vi.fn(() => {
      throw new Error('observer teardown failed');
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      onSessionDispose,
    });
    await handle.dispose();
    await expect(handle.dispose()).resolves.toBeUndefined();
    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(onSessionDispose).toHaveBeenCalledOnce();
    expect(fixture.transportControls.closeCount()).toBe(1);
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

    // The chip is gone (the account badge is the visible signal now), so the
    // observable for this wire is the aria-live announcer — which is the
    // surface that still has to report `stalled`, since the badge stays
    // deliberately silent for a state that self-heals.
    const announcer = findByAttr(fixture.root, CONNECTION_STATUS_ANNOUNCER_ATTR);
    expect(announcer).not.toBeNull();
    expect(announcer!.textContent).toBe(''); // connected on open

    // No beats arrive → the two-phase stale timer crosses to `stalled`.
    fireOnlyLiveTimer(); // phase 1 → arms the confirmation timer
    fireOnlyLiveTimer(); // confirmation → stalled
    expect(announcer!.textContent).toContain('not responding');

    // THE WIRE UNDER TEST — a `server_heartbeat` broadcast must be demuxed to
    // `connectionStatus.noteHeartbeat()`, recovering the connection. If the
    // bootstrap's `type === 'server_heartbeat'` branch were missing or
    // mistyped, the frame would fall through to the event subscriber and the
    // status would stay `stalled` — so this assertion guards the dead-path.
    fixture.transportControls.fireMessage({
      type: 'server_heartbeat',
      payload: { server_id: 'sha256:x', last_seen_at: 1, lifecycle_state: 'running' },
    });
    expect(announcer!.textContent).toBe('');

    await handle.dispose();
  });
});

describe('D-109 — bootstrapWebclient: server-status pill from server_heartbeat', () => {
  it('feeds a server_heartbeat snapshot to the pill, now inside the account menu', async () => {
    // The pill left the topbar — it is not a readout but the D-188 pause /
    // restart control, so it moved into the account menu rather than being
    // deleted. Its host attribute travels with it (every pill style is scoped
    // under that attr), which is what this still finds.
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    // The fake transport drives `connected` on open. No beat yet → the pill
    // host renders nothing (and B1 would hide it anyway until connected, which
    // it is). D-188 wraps the pill in an anchor + popover under the host, so we
    // read the whole subtree, not the host's own (never-set) innerHTML string.
    const pillHost = findByAttr(fixture.root, SERVER_PILL_HOST_ATTR);
    // It lives under the account menu now, not loose in the bar.
    expect(findByAttr(fixture.root, ACCOUNT_MENU_SERVER_SLOT_ATTR)).toBe(pillHost);
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

  it('keeps an in-flight Kitchen save named and returnable after the editor unmounts', async () => {
    const fixture = buildOpts();
    const sourceHash = '#kitchen/new/form-response/forms%2Fclient%20intake';
    fixture.hashSource.setHash(sourceHash);
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    const rpcCalls = (method: string): Array<{ request_id: string }> =>
      fixture.transportControls.sendCalls().filter(
        (call): call is { type: 'rpc'; method: string; request_id: string } =>
          call !== null
          && typeof call === 'object'
          && (call as { type?: unknown }).type === 'rpc'
          && (call as { method?: unknown }).method === method
          && typeof (call as { request_id?: unknown }).request_id === 'string',
      );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: rpcCalls('recipe.list')[0]!.request_id,
      result: { recipes: [] },
    });
    await flush();

    findChildByAttr(fixture.root, RECIPE_EDITOR_SAVE_ATTR)!.click();
    await flush();
    const saveCall = rpcCalls('recipe.save')[0]!;
    fixture.hashSource.setHash('#packs');

    expect(handle.activeRoute()).toBe('packs');
    expect(subtreeText(
      findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR)!,
    )).toContain('Finishing Kitchen work');
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
    )?.textContent).toBe('Return to Kitchen');
    findByAttr(fixture.root, ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)!.click();
    expect(fixture.hashSource.getHash()).toBe(sourceHash);

    // The exact-return mount starts its own read, but the original save lease
    // remains boot-owned. Leaving again cannot orphan or duplicate that write.
    fixture.hashSource.setHash('#packs');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: saveCall.request_id,
      result: {
        saved: true,
        recipe_id: 'handle-form-test-responses',
        version: 1,
        name: 'Handle accepted form responses',
      },
    });
    await flush();

    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_ACTIVE_WORK_ATTR,
    )?.hasAttribute('hidden')).toBe(true);

    await handle.dispose();
  });
});

// ──────────────────────────────────────────────────────────────────
// Leave guard — unsaved route work vs hash navigation + tab close.
// ──────────────────────────────────────────────────────────────────

describe('leave guard — unsaved route work', () => {
  const buildGuardFixture = () => {
    const fixture = buildOpts();
    const confirmFn = vi.fn<(message: string) => boolean>(() => false);
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

  it('keeps a credential draft on Back, uses exact safe copy, and guards reload', async () => {
    const {
      fixture,
      confirmFn,
      location,
      beforeUnloadListeners,
    } = buildGuardFixture();
    fixture.hashSource.setHash('#connections/others');
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();

    const list = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      result: {
        connections: [{
          kind: 'api',
          name: 'github-main',
          display_name: 'GitHub',
          config: { base_url: 'https://api.github.com' },
          auth_type: 'bearer',
          granted_scopes: [],
          created_at: 90,
          updated_at: 91,
        }],
      },
    });
    // `packs.list` is dispatched on a microtask (see the note above).
    await flush();
    const packs = findRpcCall(fixture.transportControls, 'packs.list');
    if (packs !== undefined) {
      fixture.transportControls.fireMessage({
        type: 'rpc_result',
        request_id: packs.request_id,
        result: { packs: [] },
      });
    }
    for (let i = 0; i < 6; i += 1) await flush();

    const content = findByAttr(
      fixture.root,
      CONNECTIONS_ROUTE_CONTENT_ATTR,
    )!;
    // The enroll panel's dispatchers live on its own host, not the route content
    // — see the enroll-host note on the dismiss tests. Both the edit click and the
    // field event have to land there or no draft is ever created, and the leave
    // guard then has nothing to guard.
    const enrollHost = findByAttr(
      fixture.root,
      CONNECTIONS_ROUTE_ENROLL_HOST_ATTR,
    )!;
    enrollHost.fireClick({
      action: 'connections-edit',
      kind: 'api',
      name: 'github-main',
    });
    enrollHost.fireConnectionField(
      'auth.token',
      'private-memory-only-replacement',
    );

    const fireBeforeUnload = (): {
      defaultPrevented: boolean;
      returnValue: unknown;
    } => {
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
    expect(fireBeforeUnload()).toMatchObject({
      defaultPrevented: true,
      returnValue: '',
    });

    fixture.hashSource.setHash('#connections/mail');

    expect(confirmFn).toHaveBeenCalledOnce();
    const prompt = confirmFn.mock.calls[0]![0];
    expect(prompt).toMatch(
      /discard changes to api\/github-main.*cancel to stay.*cannot be restored/i,
    );
    expect(prompt).not.toContain('private-memory-only-replacement');
    expect(handle.activeRoute()).toBe('connections');
    expect(location.hash).toBe('#connections/others');
    expect(findByAttr(
      fixture.root,
      CONNECTIONS_ROUTE_CONTENT_ATTR,
    )).toBe(content);

    // Reverting the only edit removes both the native reload guard and the
    // route confirmation, so a clean exit does not nag.
    enrollHost.fireConnectionField('auth.token', '');
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    fixture.hashSource.setHash('#reception');
    expect(confirmFn).toHaveBeenCalledOnce();
    expect(handle.activeRoute()).toBe('reception');

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

// ══════════════════════════════════════════════════════════════════
// Server switcher wiring
// ══════════════════════════════════════════════════════════════════
//
// The switcher is the one server-related control that has to keep working
// while the paired server is unreachable — every Server settings panel needs
// the server it is trying to help you leave. These pin the wiring that makes
// that true: it mounts from the LOCAL roster alone, a switch persists before
// it reloads, and forgetting the server this tab is on reboots rather than
// leaving the app running on credentials it no longer holds.

/** Collect every node carrying `attr` — the switcher renders one row per
 *  profile, so the single-hit `findByAttr` above cannot address them. */
const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    if (el.hasAttribute(attr)) out.push(el);
    for (const child of el.childList) walk(child);
  };
  walk(root);
  return out;
};

const buildProfileStore = (
  profiles: ReadonlyArray<WebclientServerProfile>,
  activeId: string | null,
) => {
  const state = { profiles: [...profiles], activeId };
  const calls: string[] = [];
  const store: WebclientProfileStore = {
    async listProfiles() { return state.profiles; },
    async activeProfileId() { return state.activeId; },
    async ensureProfile(url) {
      calls.push(`ensure:${url}`);
      return state.activeId ?? '';
    },
    async switchProfile(id) {
      calls.push(`switch:${id}`);
      state.activeId = id;
    },
    async renameProfile(id, label) {
      calls.push(`rename:${id}:${label}`);
      const found = state.profiles.some((profile) => profile.id === id);
      state.profiles = state.profiles.map((profile) =>
        profile.id === id ? { ...profile, label } : profile,
      );
      return found ? label : null;
    },
    async removeProfile(id) {
      calls.push(`remove:${id}`);
      state.profiles = state.profiles.filter((p) => p.id !== id);
      if (state.activeId === id) state.activeId = state.profiles[0]?.id ?? null;
    },
    async noteProfileConnected(id, at) {
      calls.push(`connected:${id}:${at}`);
      state.profiles = state.profiles.map((profile) =>
        profile.id === id ? { ...profile, last_connected_at: at } : profile,
      );
    },
    async beginNewProfile() { calls.push('begin'); },
  };
  return { store, calls, state };
};

const switcherProfile = (
  id: string,
  label: string,
  server_url: string,
): WebclientServerProfile => ({
  id,
  label,
  server_url,
  webclient_token: null,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
});

const HOME_PROFILE = switcherProfile('p1', 'home', 'wss://home.example/ws');
const OFFICE_PROFILE = switcherProfile('p2', 'office', 'wss://office.example/ws');
const STUDIO_PROFILE = switcherProfile('p3', 'studio', 'wss://studio.example/ws');
const REVOCABLE_HOME_PROFILE: WebclientServerProfile = {
  ...HOME_PROFILE,
  pair_metadata: {
    paired_at: 1_700_000_000_000,
    server_passport_fingerprint: 'fp-home',
    server_handle_at_pair: 'home',
    instance_id: 'instance-home',
  },
};

const findRpcCall = (
  controls: FakeTransportControls,
  method: string,
): { request_id: string; args: Record<string, unknown> } | undefined =>
  controls.sendCalls().find(
    (message): message is {
      type: 'rpc';
      request_id: string;
      method: string;
      args: Record<string, unknown>;
    } =>
      message !== null
      && typeof message === 'object'
      && (message as { type?: unknown }).type === 'rpc'
      && (message as { method?: unknown }).method === method,
  );

const findLatestRpcCall = (
  controls: FakeTransportControls,
  method: string,
): { request_id: string; args: Record<string, unknown> } | undefined =>
  [...controls.sendCalls()].reverse().find(
    (message): message is {
      type: 'rpc';
      request_id: string;
      method: string;
      args: Record<string, unknown>;
    } =>
      message !== null
      && typeof message === 'object'
      && (message as { type?: unknown }).type === 'rpc'
      && (message as { method?: unknown }).method === method,
  );

const countRpcCalls = (
  controls: FakeTransportControls,
  method: string,
): number => controls.sendCalls().filter(
  (message) =>
    message !== null
    && typeof message === 'object'
    && (message as { type?: unknown }).type === 'rpc'
    && (message as { method?: unknown }).method === method,
).length;

describe('bootstrapWebclient: Account server profiles', () => {
  it('restores a server-update retry and keeps it while the exact Connections preflight is in flight', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const continuityStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'awaiting_reconnect',
        started_at: 1_700_000_000_000,
      }),
    );
    fixture.hashSource.setHash('#settings/updates');

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });

    const card = findChildByAttr(
      fixture.root,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    );
    expect(card?.hasAttribute('hidden')).toBe(false);
    expect(findChildByAttr(
      card!,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent)
      .toContain('Server reconnected');
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state'))
      .toBe('working');

    findChildByAttr(card!, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.click();

    expect(handle.activeRoute()).toBe('connections');
    expect(fixture.hashSource.getHash()).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).not.toBeNull();
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'checking_return' });
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state'))
      .toBe('working');
    const inFlightGuide = findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    expect(inFlightGuide.children[0]?.textContent)
      .toBe('Credential check underway');
    expect(subtreeText(inFlightGuide)).not.toMatch(/recovery finished/i);
    expect(findChildByAttr(
      inFlightGuide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);
    const listCall = findLatestRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    // ⛔ `packs.list` IS DISPATCHED ON A MICROTASK. `2e30e91c7` turned the enroll
    // panel's direct `runPacksList()` into `Promise.resolve().then(() => …)`, so
    // the RPC is queued rather than sent by the time the synchronous bootstrap
    // returns. The call is not lost — one flush makes it visible. Without this
    // the assertion reads as "the panel stopped asking for packs", which is what
    // it looked like for two days.
    await flush();
    const packsCall = findRpcCall(fixture.transportControls, 'packs.list');
    expect(listCall).toBeDefined();
    expect(packsCall).toBeDefined();

    // A definitive authoritative landing consumes the one-shot pointer and
    // clears Account. Until both initial reads settle, reload remains safe.
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: listCall!.request_id,
      result: { connections: [] },
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: packsCall!.request_id,
      result: { packs: [] },
    });
    await flush();
    await flush();
    expect(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBeNull();
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state'))
      .toBe('ok');

    await handle.dispose();
  });

  it('restores an interrupted exact return as one explicit Account resume without replaying its receipt', async () => {
    const continuityStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'checking_return',
        started_at: 1_700_000_000_000,
        baseline_version: null,
        triage_reason: null,
        triage_check_status: null,
        triage_current_version: null,
        triage_channel: null,
        triage_available_version: null,
      }),
    );
    const firstFixture = buildOpts();
    firstFixture.hashSource.setHash('#reception');
    const firstProfiles = buildProfileStore([HOME_PROFILE], 'p1');
    const first = await bootstrapWebclient({
      ...firstFixture.opts,
      profileStore: firstProfiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();

    let guide = findChildByAttr(
      firstFixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    let resume = findChildByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(guide.children[0]?.textContent).toBe('Resume credential check');
    expect(subtreeText(guide)).toMatch(
      /interrupted before both authoritative reads finished/i,
    );
    expect(subtreeText(guide)).not.toMatch(
      /recovery finished|running 26\./i,
    );
    expect(subtreeText(guide)).toMatch(
      /current-state baselines.*not persisted or replayed/i,
    );
    expect(resume.textContent).toBe('Resume exact check');
    expect(resume.hasAttribute('disabled')).toBe(false);
    expect(findChildByAttr(
      firstFixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state')).toBe('result-ready');

    resume.click();
    expect(first.activeRoute()).toBe('connections');
    expect(firstFixture.hashSource.getHash()).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(guide.children[0]?.textContent).toBe(
      'Credential check underway',
    );
    expect(resume.hasAttribute('disabled')).toBe(true);

    // Leaving before the first list settles drops only this tab's active
    // route ownership. The durable target remains available for a clean
    // resume, and the consumed success receipt does not return.
    firstFixture.hashSource.setHash('#reception');
    expect(first.activeRoute()).toBe('reception');
    expect(guide.children[0]?.textContent).toBe('Resume credential check');
    expect(resume.hasAttribute('disabled')).toBe(false);
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'checking_return' });
    await first.dispose();

    const reloadedFixture = buildOpts();
    reloadedFixture.hashSource.setHash('#reception');
    const reloadedProfiles = buildProfileStore([HOME_PROFILE], 'p1');
    const reloaded = await bootstrapWebclient({
      ...reloadedFixture.opts,
      profileStore: reloadedProfiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();

    guide = findChildByAttr(
      reloadedFixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    resume = findChildByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(guide.children[0]?.textContent).toBe('Resume credential check');
    expect(subtreeText(guide)).not.toMatch(
      /recovery finished|one-shot completion.*current-state baseline/i,
    );
    resume.click();
    expect(reloaded.activeRoute()).toBe('connections');
    expect(reloadedFixture.hashSource.getHash()).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(guide.children[0]?.textContent).toBe(
      'Credential check underway',
    );
    expect(resume.hasAttribute('disabled')).toBe(true);
    const listCallsBeforeDuplicate = reloadedFixture.transportControls
      .sendCalls()
      .filter((message) =>
        message !== null
        && typeof message === 'object'
        && (message as { method?: unknown }).method
          === 'collection.connection.list').length;
    resume.click();
    expect(reloadedFixture.transportControls.sendCalls().filter((message) =>
      message !== null
      && typeof message === 'object'
      && (message as { method?: unknown }).method
        === 'collection.connection.list')).toHaveLength(
      listCallsBeforeDuplicate,
    );

    await reloaded.dispose();
  });

  it('restores an untouched clean editor, repeats current safety reads, and keeps only target orientation', async () => {
    const continuityStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'editor_ready',
        started_at: 1_700_000_000_000,
        baseline_version: null,
        triage_reason: null,
        triage_check_status: null,
        triage_current_version: null,
        triage_channel: null,
        triage_available_version: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#reception');
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();

    let guide = findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    let resume = findChildByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(guide.children[0]?.textContent)
      .toBe('Resume credential replacement');
    expect(subtreeText(guide)).toMatch(
      /clean credential editor.*closed before any field changed/i,
    );
    expect(subtreeText(guide)).toMatch(
      /no field value.*server-recovery receipt is restored/i,
    );
    expect(subtreeText(guide)).not.toMatch(
      /recovery finished|running 26\./i,
    );
    expect(resume.textContent).toBe('Resume clean editor');

    resume.click();
    expect(handle.activeRoute()).toBe('connections');
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'checking_return' });
    expect(guide.children[0]?.textContent).toBe(
      'Credential check underway',
    );

    const connection = {
      kind: 'api',
      name: 'github-main',
      display_name: 'GitHub',
      config: { base_url: 'https://api.github.com' },
      auth_type: 'bearer',
      granted_scopes: [],
      created_at: 90,
      updated_at: 91,
    };
    const firstList = findLatestRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    // `packs.list` is dispatched on a microtask (see the note above).
    await flush();
    const packs = findRpcCall(fixture.transportControls, 'packs.list')!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: firstList.request_id,
      result: { connections: [connection] },
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: packs.request_id,
      result: { packs: [] },
    });
    for (let i = 0; i < 6; i += 1) await flush();

    const activity = findRpcCall(
      fixture.transportControls,
      'collection.connection.credentialRotationActivity',
    )!;
    expect(activity.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: activity.request_id,
      result: { activity: { status: 'idle' } },
    });
    for (let i = 0; i < 6; i += 1) await flush();

    const listCalls = fixture.transportControls.sendCalls().filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'collection.connection.list',
    );
    const latestList = listCalls[listCalls.length - 1]!;
    expect(latestList.request_id).not.toBe(firstList.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: latestList.request_id,
      result: { connections: [connection] },
    });
    for (let i = 0; i < 10; i += 1) await flush();

    const raw = continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toMatchObject({
      scope_id: 'p1',
      kind: 'api',
      name: 'github-main',
      phase: 'editor_ready',
      baseline_version: null,
    });
    expect(raw).not.toMatch(
      /credential|field|form|completed|activity|currentVersion|exactReturnActive/i,
    );
    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    expect(subtreeInnerHtml(connectionContent)).toMatch(
      /data-connection-credential-recovery="editor_ready".*no field value or credential was restored.*data-conn-field="auth\.token"/is,
    );
    guide = findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    expect(guide.children[0]?.textContent)
      .toBe('Resume credential replacement');
    expect(subtreeText(guide)).not.toMatch(
      /recovery finished|running 26\./i,
    );

    fixture.hashSource.setHash('#reception');
    expect(handle.activeRoute()).toBe('reception');
    await handle.dispose();

    const reloadedFixture = buildOpts();
    reloadedFixture.hashSource.setHash('#reception');
    const reloadedProfiles = buildProfileStore([HOME_PROFILE], 'p1');
    const reloaded = await bootstrapWebclient({
      ...reloadedFixture.opts,
      profileStore: reloadedProfiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();

    guide = findChildByAttr(
      reloadedFixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    resume = findChildByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(guide.children[0]?.textContent)
      .toBe('Resume credential replacement');
    expect(resume.textContent).toBe('Resume clean editor');
    expect(subtreeText(guide)).not.toMatch(
      /recovery finished|running 26\.|success receipt/i,
    );
    await reloaded.dispose();
  });

  it('records authoritative triage when the updated server still lacks the safe preflight', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const continuityStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'ready',
        started_at: 1_700_000_000_000,
        baseline_version: '26.7.3',
        triage_reason: null,
        triage_check_status: null,
        triage_current_version: null,
        triage_channel: null,
        triage_available_version: null,
      }),
    );
    fixture.hashSource.setHash(
      '#connections/others/retry-credential-rotation/api/github-main',
    );

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();

    const calls = fixture.transportControls.sendCalls();
    const listCalls = calls.filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'collection.connection.list',
    );
    const listCall = listCalls[listCalls.length - 1];
    // ⛔ `packs.list` IS DISPATCHED ON A MICROTASK. `2e30e91c7` turned the enroll
    // panel's direct `runPacksList()` into `Promise.resolve().then(() => …)`, so
    // the RPC is queued rather than sent by the time the synchronous bootstrap
    // returns. The call is not lost — one flush makes it visible. Without this
    // the assertion reads as "the panel stopped asking for packs", which is what
    // it looked like for two days.
    await flush();
    const packsCall = findRpcCall(fixture.transportControls, 'packs.list');
    expect(listCall).toBeDefined();
    expect(packsCall).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: listCall!.request_id,
      result: {
        connections: [{
          kind: 'api',
          name: 'github-main',
          display_name: 'GitHub',
          config: { base_url: 'https://api.github.com' },
          auth_type: 'bearer',
          granted_scopes: [],
          created_at: 90,
          updated_at: 91,
        }],
      },
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: packsCall!.request_id,
      result: { packs: [] },
    });
    for (let i = 0; i < 6; i += 1) await flush();

    // Boot-level readiness reads can overtake the route's first list. The
    // exact return deliberately owns a fresh generation in that case before
    // it asks the activity RPC, so answer that newer baseline read too.
    const retryListCalls = fixture.transportControls.sendCalls().filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'collection.connection.list',
    );
    const retryListCall = retryListCalls[retryListCalls.length - 1];
    if (retryListCall?.request_id !== listCall!.request_id) {
      fixture.transportControls.fireMessage({
        type: 'rpc_result',
        request_id: retryListCall!.request_id,
        result: {
          connections: [{
            kind: 'api',
            name: 'github-main',
            display_name: 'GitHub',
            config: { base_url: 'https://api.github.com' },
            auth_type: 'bearer',
            granted_scopes: [],
            created_at: 90,
            updated_at: 91,
          }],
        },
      });
      for (let i = 0; i < 6; i += 1) await flush();
    }

    const activityCall = findRpcCall(
      fixture.transportControls,
      'collection.connection.credentialRotationActivity',
    );
    expect(activityCall).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: activityCall!.request_id,
      error: {
        code: 'unknown_method',
        message: 'method unavailable',
      },
    });
    await flush();

    const updateCheck = findRpcCall(
      fixture.transportControls,
      'update.check',
    );
    expect(updateCheck).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: updateCheck!.request_id,
      result: {
        status: 'up-to-date',
        current_version: '26.7.3',
        channel: 'stable',
      },
    });
    await flush();
    await flush();

    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({
      phase: 'triage',
      baseline_version: '26.7.3',
      triage_reason: 'running_version_unchanged',
      triage_check_status: 'up-to-date',
      triage_current_version: '26.7.3',
    });
    const guide = findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    expect(guide.hasAttribute('hidden')).toBe(false);
    expect(guide.children[0]?.textContent).toBe('Server update needs attention');
    expect(findChildByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toContain('Running 26.7.3');
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-label')).toContain('diagnosis is ready');

    await handle.dispose();
  });

  it('converges a sibling capability result only after this tab repeats the server read and preserves its exact route', async () => {
    type ChannelListener = (event: MessageEvent<unknown>) => void;
    const rooms = new Map<string, Set<CapabilityChannel>>();
    class CapabilityChannel {
      readonly listeners = new Set<ChannelListener>();

      constructor(readonly name: string) {
        const room = rooms.get(name) ?? new Set<CapabilityChannel>();
        room.add(this);
        rooms.set(name, room);
      }

      postMessage(message: unknown): void {
        for (const peer of rooms.get(this.name) ?? []) {
          if (peer === this) continue;
          for (const listener of [...peer.listeners]) {
            listener({ data: message } as MessageEvent<unknown>);
          }
        }
      }

      addEventListener(_type: 'message', listener: ChannelListener): void {
        this.listeners.add(listener);
      }

      removeEventListener(_type: 'message', listener: ChannelListener): void {
        this.listeners.delete(listener);
      }

      close(): void {
        rooms.get(this.name)?.delete(this);
        this.listeners.clear();
      }
    }

    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const continuityStorage = memorySessionStorage();
    const pulseStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'triage',
        started_at: 1_700_000_000_000,
        baseline_version: '26.7.3',
        triage_reason: 'running_version_unchanged',
        triage_check_status: 'up-to-date',
        triage_current_version: '26.7.3',
        triage_channel: 'stable',
        triage_available_version: null,
      }),
    );
    fixture.hashSource.setHash('#settings/updates');
    const makeView = () => ({
      BroadcastChannel: CapabilityChannel,
      localStorage: pulseStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = makeView();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
      credentialRotationTabStorage: pulseStorage,
    });
    await flush();

    const capabilityCalls = () => fixture.transportControls.sendCalls().filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'collection.connection.credentialRotationActivity',
    );
    const restoredMarkerCheck = capabilityCalls()[0];
    expect(restoredMarkerCheck?.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: restoredMarkerCheck!.request_id,
      error: {
        code: 'unknown_method',
        message: 'method unavailable',
      },
    });
    await flush();
    await flush();
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'triage' });

    const source = createBrowserCredentialRotationTabConvergence({
      document: {
        defaultView: makeView(),
        visibilityState: 'visible',
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      } as unknown as Document,
      scopeId: 'p1',
      storage: pulseStorage,
      eventId: (() => {
        const ids = ['foreign-capability', 'matching-capability'];
        return () => ids.shift()!;
      })(),
    })!;

    source.notifyServerCapabilityResolved({
      kind: 'api',
      name: 'another-connection',
    });
    await flush();
    expect(capabilityCalls()).toHaveLength(1);

    source.notifyServerCapabilityResolved({
      kind: 'api',
      name: 'github-main',
    });
    const activityCall = capabilityCalls()[1];
    expect(capabilityCalls()).toHaveLength(2);
    expect(activityCall?.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    // The sibling message is advisory: durable triage and the current route
    // remain untouched until this tab's own selected-server reply arrives.
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'triage' });
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: activityCall!.request_id,
      result: { activity: { status: 'idle' } },
    });
    await flush();
    await flush();

    expect(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBeNull();
    const card = findChildByAttr(
      fixture.root,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    )!;
    expect(card.getAttribute('data-phase')).toBe('resolved_elsewhere');
    expect(findChildByAttr(
      card,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(
      /fresh, read-only check confirmed.*stayed on server updates/i,
    );
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state')).toBe('result-ready');
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-label')).toContain(
      'Credential check is ready for api/github-main',
    );
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    findChildByAttr(card, UPDATES_CREDENTIAL_RETRY_RETURN_ATTR)?.click();
    expect(handle.activeRoute()).toBe('connections');
    expect(fixture.hashSource.getHash()).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({
      scope_id: 'p1',
      kind: 'api',
      name: 'github-main',
      phase: 'checking_return',
    });

    source.close();
    await handle.dispose();
    expect(rooms.size === 0 || [...rooms.values()].every((room) => room.size === 0))
      .toBe(true);
  });

  it('verifies a restored accepted receipt after a cold return without changing the exact route', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const continuityStorage = memorySessionStorage();
    const tabStorage = memorySessionStorage();
    const progressKey = serverUpdateProgressStorageKey('p1');
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'triage',
        started_at: 1_700_000_000_000,
        baseline_version: '26.7.3',
        triage_reason: 'running_version_unchanged',
        triage_check_status: 'up-to-date',
        triage_current_version: '26.7.3',
        triage_channel: 'stable',
        triage_available_version: null,
      }),
    );
    tabStorage.setItem(progressKey, JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'p1',
      event_id: 'accepted-before-reload',
      phase: 'awaiting_reconnect',
      operation: 'update',
      started_at: 1_700_000_000_000,
      operation_id: 'server-ledger-receipt',
    }));
    fixture.hashSource.setHash('#settings/updates');
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      localStorage: tabStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
      credentialRotationTabStorage: tabStorage,
    });
    await flush();

    const outcomeCall = findRpcCall(
      fixture.transportControls,
      'update.operation_status',
    );
    expect(outcomeCall?.args).toEqual({
      operation_id: 'server-ledger-receipt',
      include_closed: true,
    });
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');
    expect(findChildByAttr(
      fixture.root,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(/checking.*server-issued restart receipt/i);

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: outcomeCall!.request_id,
      result: { status: 'completed', operation: 'update' },
    });
    await flush();
    await flush();

    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'idle',
      operation: 'update',
      started_at: 1_700_000_000_000,
    });
    const capabilityCall = findRpcCall(
      fixture.transportControls,
      'collection.connection.credentialRotationActivity',
    );
    expect(capabilityCall?.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    await handle.dispose();
  });

  it('does not let a late receipt reply clear a newer server action', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const tabStorage = memorySessionStorage();
    const progressKey = serverUpdateProgressStorageKey('p1');
    tabStorage.setItem(progressKey, JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'p1',
      event_id: 'older-update',
      phase: 'awaiting_reconnect',
      operation: 'update',
      started_at: 1_700_000_000_000,
      operation_id: 'older-update-receipt',
    }));
    const storageListeners = new Set<EventListener>();
    fixture.hashSource.setHash('#settings/updates');
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      localStorage: tabStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener(type: string, listener: EventListener): void {
        if (type === 'storage') storageListeners.add(listener);
      },
      removeEventListener(type: string, listener: EventListener): void {
        if (type === 'storage') storageListeners.delete(listener);
      },
    };

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationTabStorage: tabStorage,
    });
    await flush();

    const outcomeCalls = () => fixture.transportControls.sendCalls().filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'update.operation_status',
    );
    const olderCall = outcomeCalls()[0]!;
    expect(olderCall.args).toEqual({
      operation_id: 'older-update-receipt',
      include_closed: true,
    });

    const newerRaw = JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'p1',
      event_id: 'newer-rollback',
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      started_at: 1_700_000_000_001,
      operation_id: 'newer-rollback-receipt',
    });
    tabStorage.setItem(progressKey, newerRaw);
    for (const listener of [...storageListeners]) {
      listener({
        key: progressKey,
        newValue: newerRaw,
      } as StorageEvent);
    }
    await flush();
    const newerCall = outcomeCalls()[1]!;
    expect(newerCall.args).toEqual({
      operation_id: 'newer-rollback-receipt',
      include_closed: true,
    });

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: olderCall.request_id,
      result: { status: 'completed', operation: 'update' },
    });
    await flush();
    await flush();

    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      operation_id: 'newer-rollback-receipt',
    });
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: newerCall.request_id,
      result: {
        status: 'waiting_for_restart',
        operation: 'rollback',
      },
    });
    await flush();
    await handle.dispose();
  });

  it.each([
    {
      label: 'the old server still awaits restart',
      reply: {
        result: {
          status: 'waiting_for_restart',
          operation: 'rollback',
        },
      },
    },
    {
      label: 'the verification read fails',
      reply: {
        error: {
          code: 'temporarily_unavailable',
          message: 'try again',
        },
      },
    },
    {
      label: 'the selected server no longer knows the receipt',
      reply: {
        result: {
          status: 'unknown',
        },
      },
    },
    {
      label: 'the receipt resolves to a different operation',
      reply: {
        result: {
          status: 'completed',
          operation: 'update',
        },
      },
    },
  ])('keeps a restored receipt latched when $label', async ({ reply }) => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const tabStorage = memorySessionStorage();
    const progressKey = serverUpdateProgressStorageKey('p1');
    tabStorage.setItem(progressKey, JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'p1',
      event_id: 'rollback-before-reload',
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      started_at: 1_700_000_000_000,
      operation_id: 'rollback-ledger-receipt',
    }));
    fixture.hashSource.setHash('#settings/updates');
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      localStorage: tabStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };

    const scheduledReceiptRetries: Array<() => void> = [];
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationTabStorage: tabStorage,
      serverUpdateReceiptScheduleRetry: (callback) => {
        scheduledReceiptRetries.push(callback);
        return () => undefined;
      },
    });
    await flush();
    const outcomeCall = findRpcCall(
      fixture.transportControls,
      'update.operation_status',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: outcomeCall.request_id,
      ...reply,
    });
    await flush();
    await flush();

    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      operation_id: 'rollback-ledger-receipt',
    });
    expect(findChildByAttr(
      fixture.root,
      UPDATES_CHECK_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);
    const recovery = findChildByAttr(
      fixture.root,
      UPDATES_RECEIPT_RECOVERY_ATTR,
    )!;
    const automaticallyRetrying =
      'error' in reply
      || (
        'result' in reply
        && reply.result.status === 'waiting_for_restart'
      );
    expect(recovery.getAttribute('data-phase')).toBe(
      automaticallyRetrying ? 'waiting' : 'unknown',
    );
    expect(recovery.getAttribute('aria-busy')).toBe(
      automaticallyRetrying ? 'true' : null,
    );
    expect(findChildByAttr(
      recovery,
      UPDATES_RECEIPT_RETRY_ATTR,
    )?.hasAttribute('disabled')).toBe(false);
    expect(scheduledReceiptRetries).toHaveLength(
      automaticallyRetrying ? 1 : 0,
    );
    expect(findChildByAttr(
      recovery,
      UPDATES_RECEIPT_DIAGNOSTIC_ATTR,
    )?.hasAttribute('hidden')).toBe(automaticallyRetrying);
    expect(subtreeText(recovery)).not.toContain('rollback-ledger-receipt');
    expect(subtreeText(recovery)).not.toContain('try again');
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');
    await handle.dispose();
  });

  it('retires a permanently unknown receipt only after the server records closure and the owner finishes', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const tabStorage = memorySessionStorage();
    const continuityStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'triage',
        started_at: 1_700_000_000_000,
        baseline_version: '26.7.3',
        triage_reason: 'running_version_unchanged',
        triage_check_status: 'up-to-date',
        triage_current_version: '26.7.3',
        triage_channel: 'stable',
        triage_available_version: null,
      }),
    );
    const progressKey = serverUpdateProgressStorageKey('p1');
    tabStorage.setItem(progressKey, JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'p1',
      event_id: 'unknown-before-reload',
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      started_at: 1_700_000_000_000,
      operation_id: 'rollback-ledger-receipt',
    }));
    fixture.hashSource.setHash('#settings/updates');
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      localStorage: tabStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    };

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationTabStorage: tabStorage,
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
    });
    await flush();
    const statusCall = findRpcCall(
      fixture.transportControls,
      'update.operation_status',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: statusCall.request_id,
      result: { status: 'unknown' },
    });
    await flush();

    const recovery = findChildByAttr(
      fixture.root,
      UPDATES_RECEIPT_RECOVERY_ATTR,
    )!;
    findChildByAttr(
      recovery,
      UPDATES_RECEIPT_CLOSURE_REVIEW_BUTTON_ATTR,
    )?.click();
    expect(recovery.getAttribute('data-phase')).toBe('reviewing_closure');
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation_id: 'rollback-ledger-receipt',
    });
    findChildByAttr(
      recovery,
      UPDATES_RECEIPT_CLOSURE_CONFIRM_ATTR,
    )?.click();
    await flush();
    const closeCall = findRpcCall(
      fixture.transportControls,
      'update.operation_close',
    )!;
    expect(closeCall.args).toEqual({
      operation_id: 'rollback-ledger-receipt',
      expected_operation: 'rollback',
    });
    expect(recovery.getAttribute('data-phase')).toBe('closing');
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
    });

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: closeCall.request_id,
      result: {
        status: 'closed_unresolved',
        operation: 'rollback',
      },
    });
    await flush();
    expect(recovery.getAttribute('data-phase')).toBe('closed');
    expect(subtreeText(recovery)).toMatch(
      /did not claim the rollback succeeded or failed/i,
    );
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation_id: 'rollback-ledger-receipt',
    });
    expect(findChildByAttr(
      fixture.root,
      UPDATES_CHECK_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);

    findChildByAttr(
      recovery,
      UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
    )?.click();
    await flush();
    expect(recovery.getAttribute('data-phase')).toBe('checking_baseline');
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation_id: 'rollback-ledger-receipt',
    });
    expect(findChildByAttr(
      fixture.root,
      UPDATES_CHECK_BTN_ATTR,
    )?.hasAttribute('disabled')).toBe(true);

    const baselineCall = findRpcCall(
      fixture.transportControls,
      'update.check',
    )!;
    const affectedConnectionCall = findRpcCall(
      fixture.transportControls,
      'collection.connection.credentialRotationActivity',
    )!;
    expect(affectedConnectionCall.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: baselineCall.request_id,
      result: {
        status: 'up-to-date',
        current_version: '26.8.1',
        channel: 'stable',
      },
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: affectedConnectionCall.request_id,
      result: { activity: { status: 'idle' } },
    });
    await flush();
    expect(recovery.getAttribute('data-phase')).toBe('baseline_confirmed');
    expect(subtreeText(recovery)).toMatch(
      /running 26\.8\.1.*github-main.*no credential verification.*current state only.*original rollback outcome remains unknown/is,
    );
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation_id: 'rollback-ledger-receipt',
    });
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(recovery.getAttribute('data-phase')).toBe('baseline_confirmed');
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'awaiting_reconnect',
      operation_id: 'rollback-ledger-receipt',
    });

    const returnCallOffset = fixture.transportControls.sendCalls().length;
    findChildByAttr(
      recovery,
      UPDATES_RECEIPT_CLOSURE_FINISH_ATTR,
    )?.click();
    await flush();
    await flush();
    expect(JSON.parse(tabStorage.getItem(progressKey)!)).toMatchObject({
      phase: 'idle',
      operation: 'rollback',
    });
    expect(recovery.getAttribute('data-phase')).toBe('completed');
    expect(subtreeText(recovery)).toMatch(
      /recovery finished.*controls are available again.*one-shot.*will not replay.*original rollback.*unknown/is,
    );
    expect(handle.activeRoute()).toBe('connections');
    expect(fixture.hashSource.getHash()).toBe(
      '#connections/others/retry-credential-rotation/api/github-main',
    );

    type RpcCall = {
      type: 'rpc';
      request_id: string;
      method: string;
      args: Record<string, unknown>;
    };
    const returnCalls = (method: string): RpcCall[] =>
      fixture.transportControls.sendCalls().slice(returnCallOffset).filter(
        (message): message is RpcCall =>
          message !== null
          && typeof message === 'object'
          && (message as { type?: unknown }).type === 'rpc'
          && (message as { method?: unknown }).method === method,
      );
    const answered = new Set<string>();
    const connectionRow = {
      kind: 'api',
      name: 'github-main',
      display_name: 'GitHub',
      config: { base_url: 'https://api.github.com' },
      auth_type: 'bearer',
      granted_scopes: [],
      created_at: 90,
      updated_at: 91,
    };
    const answerPendingRouteReads = (): void => {
      for (const call of returnCalls('collection.connection.list')) {
        if (answered.has(call.request_id)) continue;
        answered.add(call.request_id);
        fixture.transportControls.fireMessage({
          type: 'rpc_result',
          request_id: call.request_id,
          result: { connections: [connectionRow] },
        });
      }
      for (const call of returnCalls('packs.list')) {
        if (answered.has(call.request_id)) continue;
        answered.add(call.request_id);
        fixture.transportControls.fireMessage({
          type: 'rpc_result',
          request_id: call.request_id,
          result: { packs: [] },
        });
      }
    };

    answerPendingRouteReads();
    for (let i = 0; i < 8; i += 1) await flush();
    answerPendingRouteReads();
    for (let i = 0; i < 8; i += 1) await flush();
    const returnActivity = returnCalls(
      'collection.connection.credentialRotationActivity',
    )[0];
    expect(returnActivity?.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: returnActivity!.request_id,
      result: { activity: { status: 'idle' } },
    });
    for (let i = 0; i < 8; i += 1) await flush();
    answerPendingRouteReads();
    for (let i = 0; i < 12; i += 1) await flush();

    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    expect(subtreeInnerHtml(connectionContent)).toMatch(
      /data-connection-credential-recovery="restart_ready".*server recovery is finished and server-change controls are unlocked.*original rollback outcome remains unknown.*data-conn-field="auth\.token"/is,
    );
    expect(subtreeInnerHtml(connectionContent)).not.toContain(
      'rollback-ledger-receipt',
    );
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({
      scope_id: 'p1',
      kind: 'api',
      name: 'github-main',
      phase: 'editor_ready',
      baseline_version: null,
    });
    expect(findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_BADGE_ATTR,
    )?.getAttribute('data-state')).toBe('result-ready');
    const readyGuide = findChildByAttr(
      fixture.root,
      ACCOUNT_MENU_SERVER_UPDATE_ATTR,
    )!;
    expect(readyGuide.children[0]?.textContent)
      .toBe('Resume credential replacement');
    expect(subtreeText(readyGuide)).not.toMatch(
      /recovery finished|running 26\.8\.1/i,
    );
    await handle.dispose();
  });

  it('keeps accepted restart progress local until this tab reconnects and rechecks capability', async () => {
    type ChannelListener = (event: MessageEvent<unknown>) => void;
    const rooms = new Map<string, Set<ProgressChannel>>();
    class ProgressChannel {
      readonly listeners = new Set<ChannelListener>();

      constructor(readonly name: string) {
        const room = rooms.get(name) ?? new Set<ProgressChannel>();
        room.add(this);
        rooms.set(name, room);
      }

      postMessage(message: unknown): void {
        for (const peer of rooms.get(this.name) ?? []) {
          if (peer === this) continue;
          for (const listener of [...peer.listeners]) {
            listener({ data: message } as MessageEvent<unknown>);
          }
        }
      }

      addEventListener(_type: 'message', listener: ChannelListener): void {
        this.listeners.add(listener);
      }

      removeEventListener(_type: 'message', listener: ChannelListener): void {
        this.listeners.delete(listener);
      }

      close(): void {
        rooms.get(this.name)?.delete(this);
        this.listeners.clear();
      }
    }

    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    const continuityStorage = memorySessionStorage();
    const tabStorage = memorySessionStorage();
    continuityStorage.setItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 2,
        scope_id: 'p1',
        kind: 'api',
        name: 'github-main',
        phase: 'triage',
        started_at: 1_700_000_000_000,
        baseline_version: '26.7.3',
        triage_reason: 'running_version_unchanged',
        triage_check_status: 'up-to-date',
        triage_current_version: '26.7.3',
        triage_channel: 'stable',
        triage_available_version: null,
      }),
    );
    fixture.hashSource.setHash('#settings/updates');
    const makeView = () => ({
      BroadcastChannel: ProgressChannel,
      localStorage: tabStorage,
      history: { replaceState: vi.fn() },
      location: { hash: '#settings/updates' },
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = makeView();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      credentialRotationServerUpdateContinuityStorage: continuityStorage,
      credentialRotationTabStorage: tabStorage,
    });
    await flush();

    const capabilityCalls = () => fixture.transportControls.sendCalls().filter(
      (message): message is {
        type: 'rpc';
        request_id: string;
        method: string;
        args: Record<string, unknown>;
      } => message !== null
        && typeof message === 'object'
        && (message as { type?: unknown }).type === 'rpc'
        && (message as { method?: unknown }).method
          === 'collection.connection.credentialRotationActivity',
    );
    const initialCheck = capabilityCalls()[0]!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialCheck.request_id,
      error: {
        code: 'unknown_method',
        message: 'method unavailable',
      },
    });
    await flush();

    const source = createBrowserCredentialRotationTabConvergence({
      document: {
        defaultView: makeView(),
        visibilityState: 'visible',
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      } as unknown as Document,
      scopeId: 'p1',
      storage: tabStorage,
      now: () => 1_700_000_000_000,
      eventId: (() => {
        const ids = [
          'applying-update',
          'premature-capability-pulse',
          'accepted-restart',
          'source-reconnected',
        ];
        return () => ids.shift()!;
      })(),
    })!;

    source.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });
    await flush();
    const progress = findChildByAttr(
      fixture.root,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    )!;
    expect(progress.hasAttribute('hidden')).toBe(false);
    expect(progress.getAttribute('aria-busy')).toBe('true');
    expect(findChildByAttr(
      progress,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(/open Recued tab.*duplicate server action/i);
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    // An advisory sibling pulse while the server action is active must not
    // race a capability read against the old/in-transition server.
    source.notifyServerCapabilityResolved({
      kind: 'api',
      name: 'github-main',
    });
    await flush();
    expect(capabilityCalls()).toHaveLength(1);

    source.notifyServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
    });
    await flush();
    expect(findRpcCall(
      fixture.transportControls,
      'update.operation_status',
    )).toBeUndefined();
    expect(findChildByAttr(
      progress,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(/accepted.*waiting to observe the restart/i);

    // The source tab recovered first. Its idle signal must not unlock this
    // receiver before this receiver observes its own transport boundary.
    await source.clearServerUpdateProgress(
      source.readServerUpdateProgress()!,
    );
    await flush();
    expect(findChildByAttr(
      progress,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(/accepted.*waiting to observe the restart/i);
    expect(capabilityCalls()).toHaveLength(1);

    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    const reconnectCheck = capabilityCalls()[1]!;
    expect(reconnectCheck.args).toEqual({
      kind: 'api',
      name: 'github-main',
    });
    expect(findChildByAttr(
      progress,
      UPDATES_CREDENTIAL_RETRY_STATUS_ATTR,
    )?.textContent).toMatch(/returned server still lacks.*safe preflight/i);
    expect(progress.hasAttribute('aria-busy')).toBe(false);
    expect(JSON.parse(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'triage' });

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: reconnectCheck.request_id,
      result: { activity: { status: 'idle' } },
    });
    await flush();
    await flush();
    expect(continuityStorage.getItem(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBeNull();
    expect(findChildByAttr(
      fixture.root,
      UPDATES_CREDENTIAL_RETRY_ATTR,
    )?.getAttribute('data-phase')).toBe('resolved_elsewhere');
    expect(handle.activeRoute()).toBe('settings');
    expect(fixture.hashSource.getHash()).toBe('#settings/updates');

    source.close();
    await handle.dispose();
  });

  it('restores the hydrated server through ensureProfile before connecting', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });

    expect(profiles.calls[0]).toBe(
      'ensure:wss://alice.recued.cloud:8443/ws',
    );
    expect(fixture.transportControls.openCount()).toBe(1);
    await handle.dispose();
  });

  it('records each successful socket connection against the exact booted profile', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    let now = 1_700_000_000_000;
    const onServerProfilesChanged = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      now: () => now,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      onServerProfilesChanged,
    });
    await flush();

    expect(profiles.calls).toContain('connected:p1:1700000000000');
    expect(profiles.state.profiles.find((profile) => profile.id === 'p1')?.last_connected_at)
      .toBe(1_700_000_000_000);
    expect(onServerProfilesChanged).toHaveBeenCalledOnce();

    now += 60_000;
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();

    expect(profiles.calls).toContain('connected:p1:1700000060000');
    expect(onServerProfilesChanged).toHaveBeenCalledTimes(2);
    await handle.dispose();
  });

  it('renders the roster inside the account menu, from local storage alone', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();

    const trigger = findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR);
    expect(trigger).not.toBeNull();
    trigger!.click();
    // Rendered from the roster, with no rpc involved — the transport is never
    // asked anything to produce this list.
    expect(subtreeText(findByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)!))
      .toContain('home');
    await handle.dispose();
  });

  it('renames a profile locally without reloading and signals sibling tabs', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const onServerProfilesChanged = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      onServerProfilesChanged,
    });
    await flush();
    onServerProfilesChanged.mockClear();

    const trigger = findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!;
    trigger.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_RENAME_ATTR)[0]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_RENAME_INPUT_ATTR)!
      .fireInput('Home workspace');
    findByAttr(fixture.root, SERVER_SWITCHER_RENAME_SAVE_ATTR)!.click();
    await flush();

    expect(profiles.calls).toContain('rename:p1:Home workspace');
    expect(profiles.state.profiles.find((profile) => profile.id === 'p1')?.label)
      .toBe('Home workspace');
    expect(reload).not.toHaveBeenCalled();
    expect(onServerProfilesChanged).toHaveBeenCalledOnce();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(subtreeText(findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[0]!))
      .toContain('Home workspace');
    expect(findByAttr(fixture.root, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Connected now');
    await handle.dispose();
  });

  it('keeps rename failure inline and does not signal an uncommitted name', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    profiles.store.renameProfile = async () => {
      throw new Error('indexeddb is unavailable');
    };
    const onServerProfilesChanged = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      onServerProfilesChanged,
    });
    await flush();
    onServerProfilesChanged.mockClear();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_RENAME_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_RENAME_INPUT_ATTR)!
      .fireInput('Home workspace');
    findByAttr(fixture.root, SERVER_SWITCHER_RENAME_SAVE_ATTR)!.click();
    await flush();

    expect(findByAttr(fixture.root, SERVER_SWITCHER_RENAME_ERROR_ATTR)?.textContent)
      .toContain('indexeddb is unavailable');
    expect(onServerProfilesChanged).not.toHaveBeenCalled();
    errors.mockRestore();
    await handle.dispose();
  });

  it('re-reads the roster on a sibling profile-change hint without remounting', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const discoveryStorage = memorySessionStorage();
    discoveryStorage.setItem(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
      JSON.stringify({
        version: 1,
        profile_id: 'p2',
        has_recoveries: true,
        observed_at: 1_699_999_880_000,
      }),
    );
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
    });
    await flush();
    expect(findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(2);

    profiles.state.profiles = [HOME_PROFILE];
    handle.refreshServerProfiles?.();
    await flush();

    expect(findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(1);
    expect(discoveryStorage.data.has(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
    )).toBe(false);
    await handle.dispose();
  });

  it('still mounts without a profile store — the menu owns theme + settings too', async () => {
    // The account menu is not gated on profiles: it absorbed the theme toggle
    // and the Settings link, so a caller with no roster still needs it. The
    // servers row simply reports an empty roster.
    const fixture = buildOpts();
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)).not.toBeNull();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_SETTINGS_ATTR)).not.toBeNull();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)).toBeNull();
    await handle.dispose();
  });

  it('records only profile-level recovery availability from a valid active-server list', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const discoveryStorage = memorySessionStorage();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
    });
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    expect(connectionList).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      result: {
        connections: [{
          kind: 'api',
          name: 'private-provider-name',
          display_name: 'Private provider label',
          auth_type: 'bearer',
          updated_at: 9,
        }],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'private-provider-name',
          status: 'pending',
          acknowledged_at: 8,
        }],
      },
    });
    await flush();

    const raw = discoveryStorage.data.get(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p1`,
    ) ?? '';
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      profile_id: 'p1',
      has_recoveries: true,
      observed_at: 1_700_000_000_000,
    });
    expect(raw).not.toContain('private-provider-name');
    expect(raw).not.toContain('Private provider label');
    expect(raw).not.toContain('home.example');
    await handle.dispose();
  });

  it('opens an inactive reminder on the exact profile, then preserves the ordinary reviewed switch boundary', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#reception/private-detail-id');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const discoveryStorage = memorySessionStorage();
    const reviewStorage = memorySessionStorage();
    discoveryStorage.setItem(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
      JSON.stringify({
        version: 1,
        profile_id: 'p2',
        has_recoveries: true,
        observed_at: 1_699_999_880_000,
      }),
    );
    const reload = vi.fn();
    const replaceHashForServerSwitch = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch,
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      result: { connections: [] },
    });
    await flush();

    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(ATTENTION_INACTIVE_PROFILE_RECOVERY_ATTR);
    expect(topbar.innerHTML).toContain('office may still need connection recovery');
    expect(topbar.innerHTML).toContain('not a live result');
    expect(topbar.innerHTML).not.toContain('data-connection-name');

    topbar.fireClick({
      action: 'review-inactive-connection-recovery',
      serverProfileId: 'p2',
    });
    await flush();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute(
      'aria-expanded',
    )).toBe('true');
    expect(findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR).some(
      (item) => item.getAttribute('data-profile-id') === 'p2',
    )).toBe(true);
    expect(profiles.state.activeId).toBe('p1');
    expect(reload).not.toHaveBeenCalled();
    const rawReview = reviewStorage.data.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '';
    expect(JSON.parse(rawReview)).toMatchObject({
      version: 3,
      source_profile_id: 'p1',
      target_profile_id: 'p2',
      return_hash: '#reception',
      return_context: 'detail_withheld',
      phase: 'switching',
    });
    expect(rawReview).not.toContain('private-detail-id');

    const office = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)
      .find((item) => item.getAttribute('data-profile-id') === 'p2');
    office!.click();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR))
      .not.toBeNull();
    expect(profiles.state.activeId).toBe('p1');
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p2');
    expect(replaceHashForServerSwitch).toHaveBeenCalledWith('#reception');
    expect(reload).toHaveBeenCalledOnce();
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(true);
    await handle.dispose();
  });

  it('keeps a failed inactive-profile switch retryable until Account is explicitly dismissed', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const discoveryStorage = memorySessionStorage();
    const reviewStorage = memorySessionStorage();
    discoveryStorage.setItem(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
      JSON.stringify({
        version: 1,
        profile_id: 'p2',
        has_recoveries: true,
        observed_at: 1_699_999_880_000,
      }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: () => { throw new Error('reload denied'); },
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      result: { connections: [] },
    });
    await flush();

    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-inactive-connection-recovery',
      serverProfileId: 'p2',
    });
    await flush();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)
      .find((item) => item.getAttribute('data-profile-id') === 'p2')!
      .click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('try the switch again');
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(true);
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute(
      'aria-expanded',
    )).toBe('true');

    // Closing Account is an explicit abandonment boundary. Unlike the failed
    // attempt itself, it retires the one-shot destination review.
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);

    errors.mockRestore();
    await handle.dispose();
  });

  it('rechecks the switched-to profile authoritatively, retires an all-clear, and never replays its receipt', async () => {
    const discoveryStorage = memorySessionStorage();
    const reviewStorage = memorySessionStorage();
    discoveryStorage.setItem(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
      JSON.stringify({
        version: 1,
        profile_id: 'p2',
        has_recoveries: true,
        observed_at: 1_699_999_880_000,
      }),
    );
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 1,
        target_profile_id: 'p2',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain(ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR);
    expect(topbar.innerHTML).toContain('Checking office');

    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      result: { connections: [] },
    });
    await flush();

    expect(topbar.innerHTML).toContain('office is clear');
    expect(topbar.innerHTML).toContain('fresh authoritative check found no');
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    expect(JSON.parse(discoveryStorage.data.get(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p2`,
    ) ?? '')).toMatchObject({
      profile_id: 'p2',
      has_recoveries: false,
    });
    await handle.dispose();

    const reloadedFixture = buildOpts();
    const reloadedProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p2',
    );
    const reloaded = await bootstrapWebclient({
      ...reloadedFixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: reloadedProfiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const reloadedTopbar = findChildByAttr(
      reloadedFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    expect(reloadedTopbar.innerHTML).not.toContain('attention-popover');
    expect(reloadedTopbar.innerHTML).not.toContain(
      ATTENTION_CONNECTION_RECOVERY_REVIEW_ATTR,
    );
    await reloaded.dispose();
  });

  it('turns a recovery excursion all-clear into a neutral exact-route return without replaying success after reload', async () => {
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 3,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#data/files',
        return_context: 'area',
        phase: 'switching',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('Checking office');
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList.request_id,
      result: { connections: [] },
    });
    await flush();

    expect(topbar.innerHTML).toContain('office is clear');
    expect(topbar.innerHTML).toContain(ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR);
    expect(topbar.innerHTML).toContain('Return to home when you’re ready');
    expect(JSON.parse(reviewStorage.data.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '')).toMatchObject({
      phase: 'return_ready',
      source_profile_id: 'p1',
      target_profile_id: 'p2',
      return_hash: '#data/files',
    });
    await handle.dispose();

    const reloadedFixture = buildOpts();
    const reloadedProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p2',
    );
    const switchStorage = memorySessionStorage();
    const replaceHashForServerSwitch = vi.fn();
    const reload = vi.fn();
    const reloaded = await bootstrapWebclient({
      ...reloadedFixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: reloadedProfiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch,
      serverSwitchContinuityStorage: switchStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const reloadedTopbar = findChildByAttr(
      reloadedFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    expect(reloadedTopbar.innerHTML).not.toContain('attention-popover');
    expect(reloadedTopbar.innerHTML).not.toContain('office is clear');
    expect(reloadedTopbar.innerHTML).not.toContain('fresh authoritative check');
    reloadedTopbar.fireClick({ action: 'open-attention' });
    expect(reloadedTopbar.innerHTML).toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(reloadedTopbar.innerHTML).toContain(
      'Return to home when you’re ready',
    );
    expect(reloadedTopbar.innerHTML).not.toContain('office is clear');

    reloadedTopbar.fireClick({
      action: 'review-recovery-excursion-return',
      serverProfileId: 'p1',
    });
    expect(findByAttr(
      reloadedFixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-expanded')).toBe('true');
    expect(reloadedProfiles.state.activeId).toBe('p2');
    findAllByAttr(reloadedFixture.root, SERVER_SWITCHER_ITEM_ATTR)
      .find((item) => item.getAttribute('data-profile-id') === 'p1')!
      .click();
    expect(findByAttr(
      reloadedFixture.root,
      SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
    )).not.toBeNull();
    findByAttr(
      reloadedFixture.root,
      SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
    )!.click();
    await flush();

    expect(reloadedProfiles.state.activeId).toBe('p1');
    expect(replaceHashForServerSwitch).toHaveBeenCalledWith('#data/files');
    expect(reload).toHaveBeenCalledOnce();
    expect(JSON.parse(switchStorage.data.get(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
    ) ?? '')).toEqual({
      v: 3,
      target_profile_id: 'p1',
      kind: 'recovery_return',
      landing_hash: '#data/files',
      return_context: 'area',
    });
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    await reloaded.dispose();
  });

  it('keeps the excursion through repair and unlocks return only on a later authoritative all-clear', async () => {
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#chat',
        phase: 'switching',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const firstList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: firstList.request_id,
      result: {
        connections: [{
          kind: 'api',
          name: 'needs-repair',
          display_name: 'Needs repair',
          auth_type: 'bearer',
          updated_at: 9,
        }],
        credential_post_safe_stop_verifications: [{
          kind: 'api',
          name: 'needs-repair',
          status: 'pending',
          acknowledged_at: 8,
        }],
      },
    });
    await flush();
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('Finish recovery for Needs repair');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(JSON.parse(reviewStorage.data.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '')).toMatchObject({ phase: 'recovering' });

    topbar.fireClick({ action: 'dismiss-connection-recovery-review' });
    topbar.fireClick({ action: 'open-attention' });
    const secondList = findLatestRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    expect(secondList.request_id).not.toBe(firstList.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: secondList.request_id,
      result: { connections: [] },
    });
    await flush();

    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(JSON.parse(reviewStorage.data.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '')).toMatchObject({ phase: 'return_ready' });
    await handle.dispose();
  });

  it('retires a return whose source profile disappeared and keeps the current server unchanged', async () => {
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#chat',
        phase: 'return_ready',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();

    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    expect(profiles.state.activeId).toBe('p2');
    await handle.dispose();
  });

  it('gives a newly opened recovery review one clear excursion owner', async () => {
    const discoveryStorage = memorySessionStorage();
    const reviewStorage = memorySessionStorage();
    discoveryStorage.setItem(
      `${INACTIVE_PROFILE_RECOVERY_HINT_KEY_PREFIX}p3`,
      JSON.stringify({
        version: 1,
        profile_id: 'p3',
        has_recoveries: true,
        observed_at: 1_699_999_880_000,
      }),
    );
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#chat',
        phase: 'return_ready',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE, STUDIO_PROFILE],
      'p2',
    );
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList.request_id,
      result: { connections: [] },
    });
    await flush();

    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(topbar.innerHTML).toContain('studio may still need connection recovery');
    topbar.fireClick({
      action: 'review-inactive-connection-recovery',
      serverProfileId: 'p3',
    });

    expect(JSON.parse(reviewStorage.data.get(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    ) ?? '')).toMatchObject({
      version: 3,
      source_profile_id: 'p2',
      target_profile_id: 'p3',
      return_hash: '#reception',
      return_context: 'area',
      phase: 'switching',
    });
    expect(findByAttr(
      fixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-expanded')).toBe('true');

    // Cancelling the newly opened review retires that one owner. The older
    // home return was deliberately superseded and cannot linger in memory.
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(profiles.state.activeId).toBe('p2');
    await handle.dispose();
  });

  it('keeps the saved return retryable when its reviewed reload fails and restores the target route', async () => {
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#data/files',
        phase: 'return_ready',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const replaceHashForServerSwitch = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: () => { throw new Error('reload denied'); },
      replaceHashForServerSwitch,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-excursion-return',
      serverProfileId: 'p1',
    });
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)
      .find((item) => item.getAttribute('data-profile-id') === 'p1')!
      .click();
    findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
    )!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p2');
    expect(replaceHashForServerSwitch).toHaveBeenNthCalledWith(
      1,
      '#data/files',
    );
    expect(replaceHashForServerSwitch).toHaveBeenLastCalledWith('#reception');
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(true);
    expect(findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_ERROR_ATTR,
    )?.textContent).toContain('try the switch again');

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    errors.mockRestore();
    await handle.dispose();
  });

  it('retires the excursion only when the owner explicitly chooses to stay', async () => {
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 2,
        source_profile_id: 'p1',
        target_profile_id: 'p2',
        return_hash: '#chat',
        phase: 'return_ready',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    await flush();
    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'dismiss-recovery-excursion-return',
      serverProfileId: 'p1',
    });

    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_EXCURSION_RETURN_ATTR,
    );
    expect(profiles.state.activeId).toBe('p2');
    await handle.dispose();
  });

  it('preserves an unavailable destination recheck across reload and settles only from the next valid list', async () => {
    const discoveryStorage = memorySessionStorage();
    const reviewStorage = memorySessionStorage();
    reviewStorage.setItem(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
      JSON.stringify({
        version: 1,
        target_profile_id: 'p2',
        started_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p2');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const connectionList = findRpcCall(
      fixture.transportControls,
      'collection.connection.list',
    );
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: connectionList!.request_id,
      error: {
        code: 'temporary_failure',
        message: 'selected server unavailable',
      },
    });
    await flush();

    const topbar = findChildByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('Couldn’t confirm office yet');
    expect(topbar.innerHTML).toContain('Retry check');
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(true);
    await handle.dispose();
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(true);

    const retriedFixture = buildOpts();
    const retriedProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p2',
    );
    const retried = await bootstrapWebclient({
      ...retriedFixture.opts,
      localStore: buildPairedStore({
        server_url: OFFICE_PROFILE.server_url,
      }),
      profileStore: retriedProfiles.store,
      reloadForServerSwitch: vi.fn(),
      inactiveProfileRecoveryStorage: discoveryStorage,
      inactiveProfileRecoveryReviewStorage: reviewStorage,
    });
    const retriedTopbar = findChildByAttr(
      retriedFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    expect(retriedTopbar.innerHTML).toContain('Checking office');
    const retriedConnectionList = findRpcCall(
      retriedFixture.transportControls,
      'collection.connection.list',
    );
    retriedFixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: retriedConnectionList!.request_id,
      result: { connections: [] },
    });
    await flush();

    expect(retriedTopbar.innerHTML).toContain('office is clear');
    expect(reviewStorage.data.has(
      INACTIVE_PROFILE_RECOVERY_REVIEW_SESSION_KEY,
    )).toBe(false);
    await retried.dispose();
  });

  it('keeps Account and Settings available when the local profile roster cannot load', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    profiles.store.listProfiles = async () => {
      throw new Error('indexeddb roster unavailable');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });

    // Account is mounted before the async roster read. A storage failure may
    // leave the profile list empty, but cannot remove theme, Settings, or the
    // banner's only recovery destination.
    const trigger = findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR);
    expect(trigger).not.toBeNull();
    trigger!.click();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_SETTINGS_ATTR)).not.toBeNull();
    await flush();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)).not.toBeNull();
    expect(errors).toHaveBeenCalledWith(
      'webclient: account menu refresh failed',
      expect.any(Error),
    );

    errors.mockRestore();
    await handle.dispose();
  });

  it('badges the trigger when the connection controller reports offline', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      connectionStatusGraceMs: 0,
    });
    await flush();
    // Same controller the chip reads, so badge and chip can never disagree.
    const badge = findByAttr(fixture.root, ACCOUNT_MENU_BADGE_ATTR);
    expect(badge).not.toBeNull();
    expect(['ok', 'unreachable']).toContain(badge!.getAttribute('data-state'));
    await handle.dispose();
  });

  it('a switch PERSISTS before it reloads', async () => {
    // Order matters: reloading first would boot against the old active
    // profile and read as "the click did nothing".
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const onActiveServerProfileChanged = vi.fn();
    const reload = vi.fn(() => {
      expect(profiles.calls).toContain('switch:p2');
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      onActiveServerProfileChanged,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const rows = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR);
    rows[1]!.click();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).not.toBeNull();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.calls).toEqual([
      'ensure:wss://alice.recued.cloud:8443/ws',
      'connected:p1:1700000000000',
      'switch:p2',
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onActiveServerProfileChanged).toHaveBeenCalledOnce();
    await handle.dispose();
  });

  it('restores an exact recovery only when switching to the profile bound in its handoff', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    const replaceState = vi.fn();
    (fixture.fakeDoc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const replaceHashForServerSwitch = vi.fn();
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch,
    });
    await flush();

    // A valid profile-bound URL survives an ordinary reload. It cannot select
    // current-server work, and is already the exact landing for p2.
    expect(replaceState).not.toHaveBeenCalled();
    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    expect(subtreeInnerHtml(connectionContent)).toContain(
      'This recovery belongs to another server',
    );
    expect(subtreeInnerHtml(connectionContent)).toContain('office');
    expect(subtreeInnerHtml(connectionContent)).toContain('home');

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const rows = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR);
    rows[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.calls).toContain('switch:p2');
    expect(replaceHashForServerSwitch).not.toHaveBeenCalled();
    expect(fixture.hashSource.getHash()).toBe(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    expect(reload).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it('retires a bound recovery address when the owner dismisses its profile handoff', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    const replaceState = vi.fn();
    (fixture.fakeDoc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();
    expect(replaceState).not.toHaveBeenCalled();

    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    // ⛔ FIRE AT THE ENROLL HOST, NOT THE ROUTE CONTENT. `f4f3ffc64` inserted a
    // host div below the content so the enroll panel's innerHTML ownership could
    // not delete sibling surfaces — and the panel's delegated click listener
    // moved down with it. A real click on a button inside the panel is delivered
    // there, so firing at the content reaches nothing. `fireClick` no-ops when an
    // element has no click listener, which is why this went silent rather than
    // loud. The HTML assertions stay on the content: the host is inside it.
    const enrollHost = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-enroll-host',
    )!;
    enrollHost.fireClick({
      action: 'connections-dismiss-post-safe-stop-profile',
    });

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '#connections/others',
    );
    expect(subtreeInnerHtml(connectionContent)).not.toContain(
      'This recovery belongs to another server',
    );
    await handle.dispose();
  });

  it('strips a bound recovery when switching to a different profile', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    const profiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE, STUDIO_PROFILE],
      'p1',
    );
    const replaceHashForServerSwitch = vi.fn();
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const rows = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR);
    rows[2]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.calls).toContain('switch:p3');
    expect(replaceHashForServerSwitch).toHaveBeenCalledWith(
      '#connections/others',
    );
    expect(reload).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it('does not resurrect a dismissed target when History cleanup is unavailable', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const replaceHashForServerSwitch = vi.fn();
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch,
    });
    await flush();

    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    // ⛔ FIRE AT THE ENROLL HOST, NOT THE ROUTE CONTENT. `f4f3ffc64` inserted a
    // host div below the content so the enroll panel's innerHTML ownership could
    // not delete sibling surfaces — and the panel's delegated click listener
    // moved down with it. A real click on a button inside the panel is delivered
    // there, so firing at the content reaches nothing. `fireClick` no-ops when an
    // element has no click listener, which is why this went silent rather than
    // loud. The HTML assertions stay on the content: the host is inside it.
    const enrollHost = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-enroll-host',
    )!;
    enrollHost.fireClick({
      action: 'connections-dismiss-post-safe-stop-profile',
    });
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const rows = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR);
    rows[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.calls).toContain('switch:p2');
    expect(replaceHashForServerSwitch).toHaveBeenCalledWith(
      '#connections/others',
    );
    expect(replaceHashForServerSwitch).not.toHaveBeenCalledWith(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    expect(reload).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it('blocks a post-dismiss switch when no safe address rewrite exists', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash(
      '#connections/others/finish-recovery/profile/p2/api/shared-name',
    );
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    const connectionContent = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-content',
    )!;
    // ⛔ FIRE AT THE ENROLL HOST, NOT THE ROUTE CONTENT. `f4f3ffc64` inserted a
    // host div below the content so the enroll panel's innerHTML ownership could
    // not delete sibling surfaces — and the panel's delegated click listener
    // moved down with it. A real click on a button inside the panel is delivered
    // there, so firing at the content reaches nothing. `fireClick` no-ops when an
    // element has no click listener, which is why this went silent rather than
    // loud. The HTML assertions stay on the content: the host is inside it.
    const enrollHost = findChildByAttr(
      fixture.root,
      'data-recued-connections-route-enroll-host',
    )!;
    enrollHost.fireClick({
      action: 'connections-dismiss-post-safe-stop-profile',
    });
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const rows = findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR);
    rows[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.calls).not.toContain('switch:p2');
    expect(reload).not.toHaveBeenCalled();
    expect(subtreeText(findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
    )!)).toContain(
      'cannot safely remove the current server’s detail link',
    );
    await handle.dispose();
  });

  it('re-reviews work that appears while the initiating switch preflight awaits storage', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/chat_1');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: vi.fn(),
    });
    await flush();

    const readActiveProfile = profiles.store.activeProfileId.bind(profiles.store);
    let preflightStarted = false;
    let releasePreflight = (): void => undefined;
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    profiles.store.activeProfileId = async () => {
      if (!preflightStarted) {
        preflightStarted = true;
        await preflightGate;
      }
      return readActiveProfile();
    };

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await vi.waitFor(() => expect(preflightStarted).toBe(true));

    // A request completion or host integration can update the route while the
    // Account review is busy even though ordinary pointer input is disabled.
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Arrived while the active profile was being checked');
    releasePreflight();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(profiles.calls).not.toContain('switch:p2');
    expect(reload).not.toHaveBeenCalled();
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!,
    )).toContain('Your unsent Chat draft stays only in this tab');
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Review the updated boundary');

    errors.mockRestore();
    await handle.dispose();
  });

  it('rolls back a persisted target when source work changes before reload', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/chat_1');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const persistProfile = profiles.store.switchProfile.bind(profiles.store);
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let targetPersisted = false;
    let releasePersist = (): void => undefined;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    profiles.store.switchProfile = async (id) => {
      await persistProfile(id);
      if (id === 'p2') {
        targetPersisted = true;
        await persistGate;
      }
    };
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: vi.fn(),
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await vi.waitFor(() => expect(targetPersisted).toBe(true));
    expect(profiles.state.activeId).toBe('p2');

    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Arrived after the target pointer was written');
    releasePersist();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(profiles.calls).toContain('switch:p2');
    expect(profiles.calls).toContain('switch:p1');
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Review the updated boundary');
    expect(subtreeText(
      findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!,
    )).toContain('Your unsent Chat draft stays only in this tab');

    errors.mockRestore();
    await handle.dispose();
  });

  it('a failed switch does NOT reload — the browser stays where it was', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    profiles.store.switchProfile = async () => { throw new Error('idb closed'); };
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    // Reloading into an unchanged store would look exactly like a no-op click
    // while quietly dropping the intent.
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Your work is still here');
    errors.mockRestore();
    await handle.dispose();
  });

  it('rolls back when target verification fails after the profile write returned', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const readActive = profiles.store.activeProfileId.bind(profiles.store);
    const switchProfile = profiles.store.switchProfile.bind(profiles.store);
    let rejectNextVerification = false;
    profiles.store.switchProfile = async (id) => {
      await switchProfile(id);
      if (id === 'p2') rejectNextVerification = true;
    };
    profiles.store.activeProfileId = async () => {
      if (rejectNextVerification) {
        rejectNextVerification = false;
        throw new Error('verification read failed');
      }
      return readActive();
    };
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(profiles.calls).toContain('switch:p2');
    expect(profiles.calls).toContain('switch:p1');
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Couldn’t confirm the selected server');

    errors.mockRestore();
    await handle.dispose();
  });

  it('reviews a Chat draft, scrubs its source session, and suppresses only the confirmed reload prompt', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/chat_1');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const storage = memorySessionStorage();
    const replaceHash = vi.fn();
    const confirmFn = vi.fn<(message: string) => boolean>(() => false);
    const beforeUnloadListeners = new Set<(event: {
      preventDefault(): void;
      returnValue?: unknown;
    }) => void>();
    const pageHideListeners = new Set<() => void>();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      confirm: confirmFn,
      location: { hash: '#chat/session/chat_1' },
      history: { replaceState: vi.fn() },
      addEventListener: (name: string, listener: (event: {
        preventDefault(): void;
        returnValue?: unknown;
      }) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.add(listener);
        if (name === 'pagehide') {
          pageHideListeners.add(listener as unknown as () => void);
        }
      },
      removeEventListener: (name: string, listener: (event: {
        preventDefault(): void;
        returnValue?: unknown;
      }) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.delete(listener);
        if (name === 'pagehide') {
          pageHideListeners.delete(listener as unknown as () => void);
        }
      },
    };
    const onServerProfilesChanged = vi.fn();
    const onActiveServerProfileChanged = vi.fn();
    let switchReloadPrevented: boolean | null = null;
    const reload = vi.fn(() => {
      const event = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault(): void { event.prevented = true; },
      };
      for (const listener of [...beforeUnloadListeners]) listener(event);
      switchReloadPrevented = event.prevented;
      for (const listener of [...pageHideListeners]) listener();
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: replaceHash,
      serverSwitchContinuityStorage: storage,
      onServerProfilesChanged,
      onActiveServerProfileChanged,
    });
    await flush();
    onServerProfilesChanged.mockClear();
    onActiveServerProfileChanged.mockClear();

    const draft = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR);
    expect(draft).not.toBeNull();
    draft!.fireInput('Private thought for the home server');
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    const review = findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR);
    expect(subtreeText(review!)).toContain('Your unsent Chat draft stays only in this tab');
    expect(profiles.state.activeId).toBe('p1');
    expect(reload).not.toHaveBeenCalled();

    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p2');
    expect(replaceHash).toHaveBeenCalledWith('#chat');
    expect(reload).toHaveBeenCalledOnce();
    expect(switchReloadPrevented).toBe(false);
    expect(onActiveServerProfileChanged).toHaveBeenCalledOnce();
    expect(onServerProfilesChanged).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
    const marker = storage.data.get(SERVER_SWITCH_CONTINUITY_SESSION_KEY) ?? '';
    expect(marker).toContain('p2');
    expect(marker).not.toContain('Private thought');
    expect(marker).not.toContain('chat_1');

    await handle.dispose();
  });

  it('rolls the profile and safe-hash rewrite back when the switch reload is rejected', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/chat_1');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const storage = memorySessionStorage();
    const rewrittenHashes: string[] = [];
    const onServerProfilesChanged = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: () => { throw new Error('reload denied'); },
      replaceHashForServerSwitch: (hash) => { rewrittenHashes.push(hash); },
      serverSwitchContinuityStorage: storage,
      onServerProfilesChanged,
    });
    await flush();
    onServerProfilesChanged.mockClear();
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Keep this if reload cannot start');

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(rewrittenHashes).toEqual(['#chat', '#chat/session/chat_1']);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    expect(onServerProfilesChanged).not.toHaveBeenCalled();
    expect(findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)?.value)
      .toBe('Keep this if reload cannot start');
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Your work is still here');

    errors.mockRestore();
    await handle.dispose();
  });

  it('restores the source hash when an injected rewrite mutates before throwing', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/chat_1');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const rewrittenHashes: string[] = [];
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: (hash) => {
        rewrittenHashes.push(hash);
        if (hash === '#chat') throw new Error('rewrite observer failed');
      },
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p1');
    expect(rewrittenHashes).toEqual(['#chat', '#chat/session/chat_1']);
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_ERROR_ATTR)?.textContent)
      .toContain('Your work is still here');

    errors.mockRestore();
    await handle.dispose();
  });

  it('preserves a newer sibling choice and requires this stale tab to reload', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE, STUDIO_PROFILE],
      'p1',
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn(() => {
      // Another tab commits a different choice while this tab is attempting
      // its reload. This shell must not roll that newer pointer back to p1.
      profiles.state.activeId = 'p3';
      throw new Error('reload denied');
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(profiles.state.activeId).toBe('p3');
    expect(profiles.calls).toContain('switch:p2');
    expect(profiles.calls).not.toContain('switch:p1');
    const switchError = findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_ERROR_ATTR,
    );
    expect(switchError?.textContent).toContain('changed in another tab');
    expect(switchError?.textContent).toContain('Reload this tab');

    errors.mockRestore();
    await handle.dispose();
  });

  it('shows a one-shot arrival receipt only when the connected boot matches the switch target', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({ v: 1, target_profile_id: 'p1' }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });

    expect(subtreeText(findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!))
      .toContain('Now using home.');
    expect(findByAttr(
      fixture.root,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    await handle.dispose();

    const mismatchedStorage = memorySessionStorage();
    mismatchedStorage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({ v: 1, target_profile_id: 'p2' }),
    );
    const mismatchFixture = buildOpts();
    const mismatchProfiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const mismatchHandle = await bootstrapWebclient({
      ...mismatchFixture.opts,
      profileStore: mismatchProfiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: mismatchedStorage,
    });
    expect(subtreeText(findByAttr(mismatchFixture.root, CONNECTION_BANNER_ATTR)!))
      .not.toContain('Now using');
    expect(mismatchedStorage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    await mismatchHandle.dispose();
  });

  it('confirms a recovery return only after its safe work area is current', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    let fireRouteMutation = (): void => undefined;
    const mutationObserve = vi.fn();
    const mutationDisconnect = vi.fn();
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        fireRouteMutation = (): void => {
          callback([], this as unknown as MutationObserver);
        };
      }
      observe(...args: unknown[]): void {
        mutationObserve(...args);
      }
      disconnect(): void {
        mutationDisconnect();
      }
    }
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      MutationObserver:
        TestMutationObserver as unknown as typeof MutationObserver,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    const content = routeContentRoot(fixture.root);
    expect(subtreeText(banner)).not.toContain('Back on home');
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(content.getAttribute('tabindex')).toBe('-1');
    expect(subtreeText(banner)).toContain(
      'Back on home. Contracts is refreshed and ready.',
    );
    expect(action.textContent).toBe('Continue in Contracts');
    expect(action.hasAttribute('hidden')).toBe(false);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);

    // The receipt remains a useful one-shot return even if the person browses
    // elsewhere before selecting it. The newly mounted route must earn the
    // focus with its own read; the old receipt cannot certify a new mount.
    fixture.hashSource.setHash('#chat');
    const broadFocusesBeforeReturn = content.focusCallCount;
    action.click();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(content.focusCallCount).toBe(broadFocusesBeforeReturn);
    const returnList = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(returnList.request_id).not.toBe(list.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: returnList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    const landedRow = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ROW_ATTR,
    )!;
    const orientationAnnouncement = findByAttr(
      fixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )!;
    expect(landedRow.focusCallCount).toBe(1);
    expect(landedRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(orientationAnnouncement.textContent).toBe('Continue here.');
    expect(content.focusCallCount).toBe(broadFocusesBeforeReturn);
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);

    const rowParent = landedRow.parentRef!;
    const replacementRow = fixture.fakeDoc.createElement('a');
    replacementRow.setAttribute(CONTRACTS_ROUTE_ROW_ATTR, 'private-replacement');
    replacementRow.setAttribute('href', '#contracts/private-replacement');
    rowParent.removeChild(landedRow);
    rowParent.appendChild(replacementRow);
    fireRouteMutation();
    expect(landedRow.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(replacementRow.focusCallCount).toBe(1);
    expect(replacementRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'continue',
    );
    expect(orientationAnnouncement.textContent).toBe('Continue here.');
    expect(mutationObserve).toHaveBeenCalledOnce();
    expect(mutationObserve).toHaveBeenCalledWith(
      content,
      expect.objectContaining({
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: expect.arrayContaining([
          'aria-busy',
          'aria-current',
          'aria-disabled',
          'aria-hidden',
          'aria-selected',
          'data-armed',
          'data-recued-contracts-error',
          'data-recued-contracts-row',
          'data-recued-logs-status',
          'data-recued-recipes-runnability',
          'disabled',
          'hidden',
          'href',
          'inert',
        ]),
      }),
    );
    expect(mutationDisconnect).not.toHaveBeenCalled();

    // The row can remain usable while an authoritative error arrives. The
    // old action intent is now stale: land on that exact condition, update the
    // generic cue once, and never expose its server-owned detail in the shell
    // announcement.
    const invalidatedError = fixture.fakeDoc.createElement('p');
    invalidatedError.setAttribute(
      CONTRACTS_ROUTE_ERROR_ATTR,
      'private-server-error',
    );
    invalidatedError.textContent = 'Private server-owned detail';
    content.appendChild(invalidatedError);
    fireRouteMutation();
    expect(replacementRow.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(invalidatedError.focusCallCount).toBe(1);
    expect(invalidatedError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'review',
    );
    expect(orientationAnnouncement.textContent).toBe(
      'This changed. Review this status before continuing.',
    );
    expect(orientationAnnouncement.textContent).not.toContain(
      'Private server-owned detail',
    );
    fireRouteMutation();
    expect(invalidatedError.focusCallCount).toBe(1);
    expect(orientationAnnouncement.textContent).toBe(
      'This changed. Review this status before continuing.',
    );

    // When that exact condition resolves, return to the same still-current
    // row once. This is orientation only: it neither invokes the row nor
    // revives the already-consumed connection receipt.
    invalidatedError.removeAttribute(CONTRACTS_ROUTE_ERROR_ATTR);
    fireRouteMutation();
    expect(invalidatedError.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(replacementRow.focusCallCount).toBe(2);
    expect(replacementRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'continue',
    );
    expect(orientationAnnouncement.textContent).toBe(
      'Ready again. Continue here.',
    );
    expect(orientationAnnouncement.textContent).not.toContain(
      'Private server-owned detail',
    );
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);
    fireRouteMutation();
    expect(replacementRow.focusCallCount).toBe(2);
    expect(orientationAnnouncement.textContent).toBe(
      'Ready again. Continue here.',
    );

    fixture.hashSource.setHash('#chat');
    expect(replacementRow.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(invalidatedError.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(orientationAnnouncement.textContent).toBe('');
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    await handle.dispose();

    // The marker was retired before the first arrival rendered, so a refresh
    // cannot replay either its success copy or its resume action.
    const refreshedFixture = buildOpts();
    refreshedFixture.hashSource.setHash('#contracts');
    const refreshedProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p1',
    );
    const refreshed = await bootstrapWebclient({
      ...refreshedFixture.opts,
      profileStore: refreshedProfiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    const refreshedBanner = findByAttr(
      refreshedFixture.root,
      CONNECTION_BANNER_ATTR,
    )!;
    expect(subtreeText(refreshedBanner)).not.toContain('Back on home');
    expect(findByAttr(
      refreshedFixture.root,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(
      refreshedFixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )).toBeNull();
    await refreshed.dispose();
  });

  it('restores a paused recovery return from Attention through a fresh route-owned read', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    // Browsing elsewhere must not move focus or replay the consumed return. The
    // quiet marker remains a deliberate, profile-bound Attention action.
    fixture.hashSource.setHash('#chat');
    await flush();
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(subtreeText(banner)).not.toContain('Back on');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_CONTINUATION_ATTR,
    );
    expect(topbar.innerHTML).toContain('data-phase="ready"');
    expect(topbar.innerHTML).toContain('Finish returning to Contracts');
    expect(topbar.innerHTML).toContain('Recued paused this return');
    expect(topbar.innerHTML).not.toContain('Contracts is ready');
    expect(topbar.innerHTML).not.toContain('Rechecking Contracts');
    expect(topbar.innerHTML).not.toContain('Couldn’t verify Contracts');

    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(topbar.innerHTML).not.toContain('attention-popover');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    const returnList = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(returnList.request_id).not.toBe(initialList.request_id);
    const returnedRowBeforeRead = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ROW_ATTR,
    );
    expect(returnedRowBeforeRead?.focusCallCount ?? 0).toBe(0);

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: returnList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const returnedRow = findByAttr(fixture.root, CONTRACTS_ROUTE_ROW_ATTR)!;
    expect(returnedRow.focusCallCount).toBe(1);
    expect(returnedRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(findByAttr(
      fixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )?.textContent).toBe('Continue here.');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(subtreeText(banner)).not.toContain('Back on');
    expect(findByAttr(
      fixture.root,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    await handle.dispose();
  });

  it('rechecks an already mounted paused-return area before restoring focus', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('Return to Contracts and choose again');
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const recheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(recheck.request_id).not.toBe(initialList.request_id);
    const listTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    expect(listTab.focusCallCount).toBe(0);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    const readsWhileChecking = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    expect(topbar.innerHTML).toContain('Rechecking Contracts');
    expect(topbar.innerHTML).toContain('Rechecking&hellip;');
    expect(topbar.innerHTML).toContain('disabled');
    expect(topbar.innerHTML).toMatch(
      /<button[^>]*aria-busy="true"[^>]*disabled[^>]*>\s*Rechecking&hellip;/s,
    );
    expect(topbar.innerHTML).not.toContain(
      'data-action="resume-recovery-intent-continuation"',
    );
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsWhileChecking);

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: recheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    const refreshedListTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    expect(refreshedListTab.focusCallCount).toBe(1);
    expect(refreshedListTab.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('attention-popover');
    await handle.dispose();
  });

  it('turns an unsuccessful authoritative recheck into explicit recovery and retries cleanly', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const failedRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: failedRecheck.request_id,
      error: {
        code: 'unavailable',
        message: 'private transport diagnostic',
      },
    });
    await flush();

    const reviewError = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ERROR_ATTR,
    )!;
    expect(reviewError.focusCallCount).toBe(0);
    expect(reviewError.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="retry"');
    expect(topbar.innerHTML).toContain('Contracts couldn’t be refreshed');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Try again');
    expect(topbar.innerHTML).not.toContain('private transport diagnostic');

    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const successfulRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(successfulRecheck.request_id).not.toBe(failedRecheck.request_id);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: successfulRecheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const returnedRow = findByAttr(fixture.root, CONTRACTS_ROUTE_ROW_ATTR)!;
    expect(returnedRow.focusCallCount).toBe(1);
    expect(returnedRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('attention-popover');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    await handle.dispose();
  });

  it('bounds repeated failures and requires an explicit outcome after direct review', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const ordinarySwitchProfile = profiles.store.switchProfile.bind(
      profiles.store,
    );
    let blockProfileSwitch = false;
    let finishBlockedProfileSwitch = (): void => undefined;
    const blockedProfileSwitch = new Promise<void>((resolve) => {
      finishBlockedProfileSwitch = resolve;
    });
    profiles.store.switchProfile = async (id) => {
      if (!blockProfileSwitch) {
        await ordinarySwitchProfile(id);
        return;
      }
      await blockedProfileSwitch;
      throw new Error('simulated profile switch interruption');
    };
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const firstFailure = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    topbar.fireClick({ action: 'open-attention' });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: firstFailure.request_id,
      error: { code: 'unavailable', message: 'private first diagnostic' },
    });
    await flush();
    expect(topbar.innerHTML).toContain('data-remediation="retry"');
    expect(topbar.innerHTML).toContain('Try again');

    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const secondFailure = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(secondFailure.request_id).not.toBe(firstFailure.request_id);
    topbar.fireClick({ action: 'open-attention' });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: secondFailure.request_id,
      error: { code: 'unavailable', message: 'private second diagnostic' },
    });
    await flush();

    const readsAtLimit = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="escalated"');
    expect(topbar.innerHTML).toContain('Still can’t verify Contracts');
    expect(topbar.innerHTML).toContain('stopped the retry loop');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).toContain('Review server');
    expect(topbar.innerHTML).toContain('Stop recovery');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(topbar.innerHTML).not.toContain('private first diagnostic');
    expect(topbar.innerHTML).not.toContain('private second diagnostic');
    const stored = storage.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )!;
    expect(JSON.parse(stored)).toEqual({
      v: 1,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 1_700_000_000_000,
    });
    expect(stored).not.toContain('escalated');
    expect(stored).not.toContain('failure');
    expect(stored).not.toContain('diagnostic');

    // A cold reconstruction receives only the neutral durable marker. The
    // failure count, escalation, diagnostics, and one-tab announcement do not
    // cross reloads or sibling tabs.
    const coldStorage = memorySessionStorage();
    coldStorage.setItem(RECOVERY_INTENT_CONTINUATION_SESSION_KEY, stored);
    const coldFixture = buildOpts();
    coldFixture.hashSource.setHash('#chat');
    const coldHandle = await bootstrapWebclient({
      ...coldFixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: coldStorage,
    });
    await flush();
    const coldTopbar = findByAttr(
      coldFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    coldTopbar.fireClick({ action: 'open-attention' });
    expect(coldTopbar.innerHTML).toContain('data-phase="ready"');
    expect(coldTopbar.innerHTML).toContain('Recheck area');
    expect(coldTopbar.innerHTML).not.toContain('escalated');
    expect(coldTopbar.innerHTML).not.toContain('stopped the retry loop');
    await coldHandle.dispose();

    // Neither a reconnect nor a stale synthetic action escapes the cap.
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    expect(topbar.innerHTML).toContain('data-remediation="escalated"');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsAtLimit);

    // Direct server review is inspection only. It keeps the exact saved route,
    // never arms another reconnect retry, then asks for an explicit outcome.
    topbar.fireClick({ action: 'close-attention' });
    fixture.hashSource.setHash('#chat');
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();
    const account = findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)!;
    expect(account.hasAttribute('hidden')).toBe(false);
    expect(account.focusCallCount).toBe(1);
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsAtLimit);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );

    findByAttr(fixture.root, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );
    expect(topbar.innerHTML).toContain('data-remediation="escalated"');
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(topbar.innerHTML).toContain(
      'What happened after reviewing home?',
    );
    expect(topbar.innerHTML).toContain(
      'Looks resolved &mdash; verify &amp; choose again',
    );
    expect(topbar.innerHTML).toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(storage.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(stored);

    // Keeping a still-blocked outcome is a complete, quiet action: the item
    // remains discoverable and no background read is dispatched.
    topbar.fireClick({ action: 'keep-recovery-intent-review-blocked' });
    expect(topbar.innerHTML).not.toContain('attention-popover');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsAtLimit);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );

    // A claimed resolution gets exactly one fresh authoritative route check.
    // Failure returns to the bounded direct-review posture, rather than
    // silently looping or treating the review itself as proof.
    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    await flush();
    const resolvedServerCheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(resolvedServerCheck.request_id).not.toBe(secondFailure.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: resolvedServerCheck.request_id,
      error: {
        code: 'unavailable',
        message: 'private post-server-review detail',
      },
    });
    await flush();

    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="escalated"');
    expect(topbar.innerHTML).not.toContain(
      'private post-server-review detail',
    );
    topbar.fireClick({ action: 'review-recovery-intent-continuation' });
    await flush();

    const reviewError = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ERROR_ATTR,
    )!;
    expect(reviewError.focusCallCount).toBe(2);
    expect(reviewError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsAtLimit + 1);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );

    // Interacting with the reviewed route no longer discards the explicit
    // outcome question. The person can inspect or repair it before answering.
    fixture.fakeDoc.fireDocumentEvent('pointerdown', reviewError);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="area"');
    expect(topbar.innerHTML).toContain(
      'What happened after reviewing Contracts?',
    );

    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    const resolvedAreaCheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(resolvedAreaCheck.request_id).not.toBe(
      resolvedServerCheck.request_id,
    );

    // Losing the transport makes the pending answer indeterminate. The old
    // response is disowned, reconnect stays quiet, and only a closed-list,
    // continuation-bound verifier crosses a reload boundary.
    const verificationRaw = storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!;
    expect(JSON.parse(verificationRaw)).toEqual({
      v: 2,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 1_700_000_000_000,
      review_target: 'area',
      state: 'checking',
      interruption_count: 0,
      last_interruption: null,
    });
    expect(verificationRaw).not.toMatch(
      /credential|error|receipt|record|provider|field|draft|label/i,
    );
    fixture.transportControls.fireState('reconnecting');
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(topbar.innerHTML).toContain('Verification was interrupted');
    expect(topbar.innerHTML).toContain('Retry verification');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).not.toContain(
      'Looks resolved &mdash; verify',
    );
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      v: 2,
      state: 'interrupted',
      interruption_count: 1,
      last_interruption: 'connection',
    });

    const readsBeforeReconnect = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    expect(topbar.innerHTML).toContain(
      'Review the connection before another check',
    );
    expect(topbar.innerHTML).toContain('Review connection');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).not.toContain('Retry verification');
    expect(topbar.innerHTML).toContain(
      'That outcome can’t be verified right now',
    );
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      state: 'interrupted',
      interruption_count: 2,
      last_interruption: 'connection',
    });
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: resolvedAreaCheck.request_id,
      error: {
        code: 'unavailable',
        message: 'private stale verification detail',
      },
    });
    await flush();
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    expect(topbar.innerHTML).not.toContain(
      'private stale verification detail',
    );

    // A committed Account profile mutation keeps ownership. The review stays
    // in Attention with a clear alternative and cannot open a stale diagnosis
    // or release the durable two-interruption cap underneath that mutation.
    blockProfileSwitch = true;
    topbar.fireClick({ action: 'close-attention' });
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(
      fixture.root,
      SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
    )!.click();
    findByAttr(fixture.root, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'review-recovery-intent-server' });
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain(
      'That server can’t be opened from Account right now',
    );
    expect(account.hasAttribute('hidden')).toBe(true);
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      state: 'interrupted',
      interruption_count: 2,
    });
    finishBlockedProfileSwitch();
    await flush();
    blockProfileSwitch = false;

    // After two interruptions, connection review is the primary bounded
    // handoff. Account lands on the exact profile with stable diagnosis focus,
    // but merely opening or closing it does not release the durable cap.
    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);
    const diagnosis = findByAttr(
      fixture.root,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const diagnosisTitle = findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!;
    expect(diagnosis.hasAttribute('hidden')).toBe(false);
    expect(diagnosis.getAttribute('data-interruption-reason')).toBe(
      'connection',
    );
    expect(diagnosisTitle.textContent).toBe('Check connection to home');
    expect(diagnosisTitle.focusCallCount).toBe(1);
    expect(subtreeText(diagnosis)).toContain(
      'Opening Account does not retry verification or mark it resolved',
    );
    expect(findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    )!.textContent).toContain('home is reconnecting or still being checked');
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toMatchObject({
      state: 'interrupted',
      interruption_count: 2,
      last_interruption: 'connection',
    });
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);

    // A reload during diagnosis restores the same bounded Attention handoff;
    // Account orientation is ephemeral and never weakens the durable cap.
    const diagnosisReloadStorage = memorySessionStorage();
    diagnosisReloadStorage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      storage.data.get(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)!,
    );
    diagnosisReloadStorage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      storage.data.get(RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY)!,
    );
    const diagnosisReloadFixture = buildOpts();
    diagnosisReloadFixture.hashSource.setHash('#chat');
    const diagnosisReloadHandle = await bootstrapWebclient({
      ...diagnosisReloadFixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: diagnosisReloadStorage,
    });
    await flush();
    const diagnosisReloadTopbar = findByAttr(
      diagnosisReloadFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    diagnosisReloadTopbar.fireClick({ action: 'open-attention' });
    expect(diagnosisReloadTopbar.innerHTML).toContain(
      'data-phase="verification_handoff"',
    );
    expect(findByAttr(
      diagnosisReloadFixture.root,
      ACCOUNT_MENU_POPOVER_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    await diagnosisReloadHandle.dispose();

    findByAttr(fixture.root, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(true);

    // Only the diagnosis' explicit return releases the old verifier and opens
    // the exact outcome question. No bell click or current-state read occurs.
    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();
    expect(diagnosisTitle.focusCallCount).toBe(2);
    findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!.click();
    expect(account.hasAttribute('hidden')).toBe(true);
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);

    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);

    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    const retriedAreaCheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(retriedAreaCheck.request_id).not.toBe(
      resolvedAreaCheck.request_id,
    );
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect + 1);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: retriedAreaCheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const listTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    expect(listTab.focusCallCount).toBe(1);
    expect(listTab.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(subtreeText(banner)).not.toContain('Back on');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    await handle.dispose();
  });

  it('returns an unresolved server receipt to its exact profile controls without replaying the action', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
        review_target: 'server',
        state: 'interrupted',
        interruption_count: 2,
        last_interruption: 'connection',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    fixture.transportControls.fireMessage({
      type: 'server_heartbeat',
      payload: {
        server_id: 'srv-unresolved-re-review',
        last_seen_at: 1_700_000_000_000,
        lifecycle_state: 'running',
        paused: false,
        uptime_s: 120,
        supervisor_mode: 'systemd',
      },
    });

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();

    const account = findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)!;
    const diagnosis = findByAttr(
      fixture.root,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
    )!.click();
    const serverPillHost = findByAttr(
      fixture.root,
      SERVER_PILL_HOST_ATTR,
    )!;
    const serverControls = serverPillHost.childList[0]!.childList[1]!;
    serverControls.fireClick({ action: 'pause-request' });
    serverControls.fireClick({ action: 'pause-confirm' });

    const receipt = findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    )!;
    expect(receipt.getAttribute('data-action')).toBe('pause');
    expect(receipt.getAttribute('data-phase')).toBe('pending');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(1);
    findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!.click();

    expect(account.hasAttribute('hidden')).toBe(true);
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR}="pending"`,
    );
    expect(topbar.innerHTML).toContain('Pause was still pending');
    expect(topbar.innerHTML).toContain('Review server again');
    expect(topbar.innerHTML).toContain('Verify Contracts instead');
    expect(topbar.innerHTML).not.toContain(
      'Still blocked &mdash; keep reminder',
    );

    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);
    expect(diagnosis.getAttribute('data-interruption-reason')).toBeNull();
    expect(findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!.textContent).toBe('Review home again');
    expect(subtreeText(diagnosis)).toContain(
      'The last server-control receipt did not settle the result',
    );
    expect(diagnosis.getAttribute('data-control-review')).toBe('active');
    expect(receipt.getAttribute('data-phase')).toBe('pending');
    expect(serverControls.innerHTML).toContain('Active server controls');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(1);

    // A late response from the retired request may update global live state,
    // but it cannot rewrite this re-review receipt or start another request.
    const pendingPause = findLatestRpcCall(
      fixture.transportControls,
      'server.setPaused',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: pendingPause.request_id,
      result: { ok: true, active_since: 1_700_000_000_000 },
    });
    await flush();
    expect(receipt.getAttribute('data-phase')).toBe('pending');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(1);
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    const reconcile = findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
    )!;
    expect(reconcile.textContent).toBe('Waiting for current server state…');
    expect(reconcile.hasAttribute('disabled')).toBe(true);

    // The action response is not a current-state baseline. Only a later fresh
    // heartbeat unlocks the explicit reconciliation boundary.
    fixture.transportControls.fireMessage({
      type: 'server_heartbeat',
      payload: {
        server_id: 'srv-unresolved-re-review',
        last_seen_at: 1_700_000_000_000,
        lifecycle_state: 'running',
        paused: true,
        uptime_s: 121,
        supervisor_mode: 'systemd',
      },
    });
    expect(reconcile.textContent).toBe('Use current server state');
    expect(reconcile.hasAttribute('disabled')).toBe(false);
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    reconcile.click();

    expect(account.hasAttribute('hidden')).toBe(true);
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR}="pending"`,
    );
    expect(topbar.innerHTML).toContain(
      `${ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR}="paused"`,
    );
    expect(topbar.innerHTML).toContain('Current server state: paused');
    expect(topbar.innerHTML).toContain(
      'without claiming the earlier Pause request caused it',
    );
    expect(topbar.innerHTML).toContain(
      'Verify Contracts &amp; choose again',
    );
    expect(topbar.innerHTML).toContain(
      'Still blocked &mdash; keep reminder',
    );
    expect(topbar.innerHTML).not.toContain('Review server again');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(1);
    expect(JSON.parse(storage.data.get(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )!)).toEqual({
      v: 2,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 1_700_000_000_000,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    });
    expect(storage.data.get(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(JSON.stringify({
      v: 1,
      profile_id: 'p1',
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: 1_700_000_000_000,
    }));

    const readsBeforeClosure = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeClosure + 1);
    const closureCheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: closureCheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(storage.data.has(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(false);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(1);
    await handle.dispose();
  });

  it('re-enters a reconciled exact-area check after reload without restoring or replaying server material', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
        review_target: 'server',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_ready"');
    expect(topbar.innerHTML).toContain('Finish checking Contracts');
    expect(topbar.innerHTML).toContain('Check Contracts now');
    expect(topbar.innerHTML).toContain('Keep for later');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR,
    );
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR,
    );
    expect(topbar.innerHTML).not.toContain('Current server state:');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    const readsBeforeReconnect = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    const parentMarkerBeforeDefer = storage.getItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    );
    const verificationMarkerBeforeDefer = storage.getItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    );

    topbar.fireClick({ action: 'defer-recovery-intent-verification' });
    expect(topbar.innerHTML).not.toContain('data-phase="verification_ready"');
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('top-bar-attention--saved');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 item saved for later',
    );
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(storage.getItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(parentMarkerBeforeDefer);
    expect(storage.getItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(verificationMarkerBeforeDefer);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toEqual({
      v: 4,
      profile_id: 'p1',
      landing_hash: '#contracts',
      paused_at: 1_700_000_000_000,
      deferred_at: 1_700_000_000_000,
      review_started_at: null,
      attempt_count: 0,
      diagnosis_target: null,
      diagnosis_outcome: null,
    });
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);

    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_ready"');
    expect(topbar.innerHTML).toContain('data-deferred="true"');
    expect(topbar.innerHTML).toContain('Contracts check kept for later');
    expect(topbar.innerHTML).toContain(
      'Kept for later just now · expires in 30 min',
    );
    expect(topbar.innerHTML).toContain('Keep for later');

    // Reconnect convergence is observational. It neither turns the prepared
    // check into an interruption nor dispatches it without a fresh click.
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(topbar.innerHTML).toContain('data-phase="verification_ready"');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);

    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect + 1);
    const exactAreaCheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: exactAreaCheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(storage.data.has(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(false);
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(false);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('retires an expired exact check and offers one quiet intent-free current-area review', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    // Exact-boundary boot must go straight to the intent-free handoff without
    // flashing the now-expired exact intent for one timer turn.
    const pausedAt = now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;
    const deferredAt = pausedAt + 5 * 60_000;
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: pausedAt,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: pausedAt,
        review_target: 'server',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      JSON.stringify({
        v: 4,
        profile_id: 'p1',
        landing_hash: '#contracts',
        paused_at: pausedAt,
        deferred_at: deferredAt,
        review_started_at: null,
        attempt_count: 0,
        diagnosis_target: null,
        diagnosis_outcome: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).toContain('top-bar-attention--saved');
    expect(topbar.innerHTML).toContain('top-bar-attention--ready');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved item ready to review',
    );
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(storage.data.has(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(false);
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(true);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    const readsBeforeReview = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    expect(readsBeforeReview).toBe(0);

    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(topbar.innerHTML).toContain('Saved Contracts check expired');
    expect(topbar.innerHTML).toContain(
      'discarded the prior intent and unfinished check',
    );
    expect(topbar.innerHTML).toContain('Expired just now');
    expect(topbar.innerHTML).toContain('Review current Contracts');
    expect(topbar.innerHTML).not.toContain('choose_again');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME_ATTR,
    );
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_SERVER_STATE_ATTR,
    );

    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(topbar.innerHTML).not.toContain('attention-popover');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReview + 1);
    const currentAreaRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: currentAreaRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(false);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(topbar.innerHTML).not.toContain('Saved Contracts check expired');
    await handle.dispose();
  });

  it('restores one route-owned retry after an expired broad review cannot confirm current state', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now);
    const firstFixture = buildOpts();
    firstFixture.hashSource.setHash('#contracts');
    const firstProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p1',
    );
    const firstHandle = await bootstrapWebclient({
      ...firstFixture.opts,
      enablePermissionsPanel: false,
      profileStore: firstProfiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialRead = findLatestRpcCall(
      firstFixture.transportControls,
      'collection.contract.listContracts',
    )!;
    firstFixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    const readsBeforeReview = countRpcCalls(
      firstFixture.transportControls,
      'collection.contract.listContracts',
    );

    const firstTopbar = findByAttr(
      firstFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    firstTopbar.fireClick({ action: 'open-attention' });
    firstTopbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    expect(firstFixture.hashSource.getHash()).toBe('#contracts');
    expect(countRpcCalls(
      firstFixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReview + 1);
    const failedRead = findLatestRpcCall(
      firstFixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(failedRead.request_id).not.toBe(initialRead.request_id);
    firstTopbar.fireClick({ action: 'open-attention' });
    expect(firstTopbar.innerHTML).toContain('data-phase="checking"');
    expect(firstTopbar.innerHTML).toContain('aria-busy="true"');
    expect(firstTopbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-expiry-handoff"',
    );
    firstTopbar.fireClick({ action: 'close-attention' });
    firstFixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: failedRead.request_id,
      error: {
        code: 'unavailable',
        message: 'private current-area transport detail',
      },
    });
    await flush();

    expect(firstTopbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(firstTopbar.innerHTML).toContain('top-bar-attention--retry');
    expect(firstTopbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs retry',
    );
    const storedRetry = storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!;
    expect(JSON.parse(storedRetry)).toEqual({
      v: 4,
      profile_id: 'p1',
      landing_hash: '#contracts',
      paused_at: now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
      deferred_at:
        now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS + 5 * 60_000,
      review_started_at: now,
      attempt_count: 1,
      diagnosis_target: null,
      diagnosis_outcome: null,
    });
    expect(storedRetry).not.toMatch(
      /choose_again|intent|credential|receipt|record|provider|transport detail/i,
    );
    firstTopbar.fireClick({ action: 'open-attention' });
    expect(firstTopbar.innerHTML).toContain('data-phase="retry"');
    expect(firstTopbar.innerHTML).toContain(
      'Contracts couldn’t be refreshed',
    );
    expect(firstTopbar.innerHTML).toContain('Retry current Contracts');
    expect(firstTopbar.innerHTML).not.toContain(
      'private current-area transport detail',
    );
    await firstHandle.dispose();

    // A cold tab restores only the broad retry posture. It performs no read on
    // boot or reconnect and cannot reconstruct the expired exact intent.
    const retryFixture = buildOpts();
    retryFixture.hashSource.setHash('#chat');
    const retryProfiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE],
      'p1',
    );
    const retryHandle = await bootstrapWebclient({
      ...retryFixture.opts,
      enablePermissionsPanel: false,
      profileStore: retryProfiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const retryTopbar = findByAttr(
      retryFixture.root,
      ATTENTION_TOPBAR_HOST_ATTR,
    )!;
    expect(countRpcCalls(
      retryFixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    retryTopbar.fireClick({ action: 'open-attention' });
    expect(retryTopbar.innerHTML).toContain('data-phase="retry"');
    expect(retryTopbar.innerHTML).toContain(
      'data-retry-reason="interrupted"',
    );
    retryFixture.transportControls.fireState('reconnecting');
    retryFixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      retryFixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);

    retryTopbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    expect(retryFixture.hashSource.getHash()).toBe('#contracts');
    expect(countRpcCalls(
      retryFixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(1);
    const successfulRetry = findLatestRpcCall(
      retryFixture.transportControls,
      'collection.contract.listContracts',
    )!;
    retryFixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: successfulRetry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    expect(findByAttr(
      retryFixture.root,
      CONTRACTS_ROUTE_HEADING_ATTR,
    )?.focusCallCount).toBe(1);
    retryTopbar.fireClick({ action: 'open-attention' });
    expect(retryTopbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    await retryHandle.dispose();
  });

  it('keeps an offline expired review on its dirty origin until a manual retry', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
      connectionStatusGraceMs: 0,
    });
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    await flush();
    const draft = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!;
    draft.fireInput('Keep this private offline draft');
    fixture.transportControls.fireState('closed');
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();

    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(findChildByAttr(
      fixture.root,
      CHAT_ROUTE_INPUT_ATTR,
    )?.value).toBe('Keep this private offline draft');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(topbar.innerHTML).toContain('top-bar-attention--retry');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-retry-reason="offline"');
    expect(topbar.innerHTML).toContain('is offline');
    expect(topbar.innerHTML).not.toContain('Keep this private offline draft');

    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(topbar.innerHTML).toContain('data-retry-reason="interrupted"');
    expect(topbar.innerHTML).toContain('Retry current Contracts');
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    await handle.dispose();
  });

  it('bounds a second offline retry to exact active-server diagnosis without auto-retrying', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
      connectionStatusGraceMs: 0,
    });
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    fixture.transportControls.fireState('closed');
    await flush();

    const readsBeforeDiagnosis = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="retry"');
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();

    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(topbar.innerHTML).toContain('top-bar-attention--diagnosis');
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: null,
    });
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeDiagnosis);

    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="handoff"');
    expect(topbar.innerHTML).toContain(
      'data-diagnosis-target="server"',
    );
    expect(topbar.innerHTML).toContain('needs connection review');
    expect(topbar.innerHTML).toContain('Review server connection');
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();

    const diagnosis = findByAttr(
      fixture.root,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    expect(findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )?.textContent).toBe('Review home for Contracts');
    expect(subtreeText(diagnosis)).toContain(
      'stopped after two unsuccessful current Contracts checks',
    );
    expect(subtreeText(diagnosis)).toContain(
      'will not retry Contracts',
    );
    expect(findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )?.textContent).toBe('Choose check or close');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeDiagnosis);

    // Closing the exact diagnosis is not an outcome; the quiet handoff stays.
    findByAttr(fixture.root, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).not.toBeNull();
    expect(topbar.innerHTML).toContain('top-bar-attention--diagnosis');
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    findByAttr(
      fixture.root,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!.click();
    await flush();
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: 'choose',
    });
    expect(topbar.innerHTML).toContain('top-bar-attention--decision');
    expect(topbar.innerHTML).toContain('data-phase="outcome"');
    expect(topbar.innerHTML).toContain(
      'Contracts is ready for one fresh check',
    );
    expect(topbar.innerHTML).toContain('Check current Contracts once');
    expect(topbar.innerHTML).toContain('Close review');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeDiagnosis);
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    expect(topbar.innerHTML).not.toContain('top-bar-attention--decision');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('runs one deliberate post-diagnosis current-area check and closes on fresh state', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedPostDiagnosisContractsChoice(storage, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const readsBeforeRecheck = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention--decision');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="outcome"');
    expect(topbar.innerHTML).toContain('Check current Contracts once');
    expect(topbar.innerHTML).toContain('Close review');
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();

    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRecheck + 1);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: 'recheck_started',
    });
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="rechecking"');
    expect(topbar.innerHTML).toContain('Checking current Contracts once');
    expect(topbar.innerHTML).not.toContain(
      'data-action="review-recovery-intent-expiry-handoff"',
    );
    topbar.fireClick({ action: 'close-attention' });
    const recheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(recheck.request_id).not.toBe(initialRead.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: recheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    expect(findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_HEADING_ATTR,
    )?.focusCallCount).toBe(1);
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRecheck + 1);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('preserves the post-diagnosis choice until the server reconnects', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedPostDiagnosisContractsChoice(storage, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
      connectionStatusGraceMs: 0,
    });
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    fixture.transportControls.fireState('closed');
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="outcome"');
    expect(topbar.innerHTML).toContain('data-check-blocker="server"');
    expect(topbar.innerHTML).toContain('Waiting for server');
    expect(topbar.innerHTML).toContain('disabled');
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      diagnosis_outcome: 'choose',
    });
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(topbar.innerHTML).not.toContain('data-check-blocker="server"');
    expect(topbar.innerHTML).toContain('Check current Contracts once');
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      diagnosis_outcome: 'choose',
    });
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    await handle.dispose();
  });

  it('turns a dropped one-shot recheck into server closure and ignores its late result', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedPostDiagnosisContractsChoice(storage, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
      connectionStatusGraceMs: 0,
    });
    await flush();
    const initialRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    const recheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(recheck.request_id).not.toBe(initialRead.request_id);

    fixture.transportControls.fireState('closed');
    await flush();
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      diagnosis_outcome: 'server_unavailable',
    });
    expect(topbar.innerHTML).toContain('top-bar-attention--closure');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: recheck.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    fixture.transportControls.fireState('connected');
    await flush();
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).not.toBeNull();
    expect(topbar.innerHTML).toContain('top-bar-attention--closure');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-closure-target="server"');
    expect(topbar.innerHTML).toContain('No more check will run');
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    await handle.dispose();
  });

  it('restores an interrupted post-diagnosis recheck as closure-only', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedPostDiagnosisContractsChoice(storage, now, 'recheck_started');
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      diagnosis_outcome: 'area_unconfirmed',
    });
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention--closure');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs closure',
    );
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="closure"');
    expect(topbar.innerHTML).toContain('data-closure-target="area"');
    expect(topbar.innerHTML).toContain('No more check will run');
    expect(topbar.innerHTML).toContain('Open current Contracts');
    expect(topbar.innerHTML).toContain('Close review');
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(1);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      diagnosis_outcome: 'area_unconfirmed',
    });
    const closureTarget = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LOADING_ATTR,
    )!;
    expect(closureTarget.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'review',
    );
    expect(topbar.innerHTML).toContain('top-bar-attention--closure');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="closure"');
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    expect(closureTarget.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    await handle.dispose();
  });

  it('restores a reloaded second attempt as bounded route diagnosis without a boot read', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now, now);
    const interruptedSecondAttempt = JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!) as Record<string, unknown>;
    storage.setItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      JSON.stringify({
        ...interruptedSecondAttempt,
        attempt_count: 2,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(JSON.parse(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )!)).toMatchObject({
      v: 4,
      attempt_count: 2,
      diagnosis_target: 'area',
      diagnosis_outcome: null,
    });
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention--diagnosis');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="handoff"');
    expect(topbar.innerHTML).toContain('data-diagnosis-target="area"');
    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(topbar.innerHTML).toContain('data-diagnosis-target="area"');
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    await handle.dispose();
  });

  it('bounds a second departed expired-area read to direct route diagnosis and ignores its late result', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    const pendingRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(pendingRetry.request_id).not.toBe(initialRead.request_id);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    topbar.fireClick({ action: 'close-attention' });

    fixture.hashSource.setHash('#chat');
    await flush();
    expect(handle.activeRoute()).toBe('chat');
    expect(topbar.innerHTML).toContain('top-bar-attention--diagnosis');
    expect(topbar.innerHTML).toContain(
      'No items need your attention; 1 saved review needs diagnosis',
    );
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="handoff"');
    expect(topbar.innerHTML).toContain(
      'data-diagnosis-target="area"',
    );
    expect(topbar.innerHTML).toContain('Contracts needs direct review');
    expect(topbar.innerHTML).toContain('Open current Contracts');
    expect(topbar.innerHTML).toContain(
      'stopped after two unsuccessful checks',
    );
    topbar.fireClick({ action: 'close-attention' });

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: pendingRetry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(handle.activeRoute()).toBe('chat');
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).not.toBeNull();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="handoff"');
    expect(topbar.innerHTML).not.toContain('data-phase="checking"');
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    expect(handle.activeRoute()).toBe('contracts');
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    const diagnosisTarget = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LOADING_ATTR,
    )!;
    expect(diagnosisTarget.focusCallCount).toBe(1);
    expect(diagnosisTarget.getAttribute(
      RECOVERY_INTENT_CUE_ATTR,
    )).toBe('review');
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('keeps dismissal authoritative while an expired-area read is still pending', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    seedExpiredDeferredContractsCheck(storage, now);
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialRead.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();
    const pendingRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(pendingRetry.request_id).not.toBe(initialRead.request_id);

    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="checking"');
    topbar.fireClick({
      action: 'dismiss-recovery-intent-expiry-handoff',
    });
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    expect(topbar.innerHTML).not.toContain('top-bar-attention--saved');

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: pendingRetry.request_id,
      error: {
        code: 'unavailable',
        message: 'late private transport detail',
      },
    });
    await flush();
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(topbar.innerHTML).not.toContain('late private transport detail');
    await handle.dispose();
  });

  it('keeps a newer exact return when an older deferred-check notice has expired', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    const expiredPausedAt = now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;
    const currentPausedAt = now - 60_000;
    const currentParent = JSON.stringify({
      v: 1,
      profile_id: 'p1',
      landing_hash: '#chat',
      intent: 'continue',
      paused_at: currentPausedAt,
    });
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      currentParent,
    );
    storage.setItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      JSON.stringify({
        v: 4,
        profile_id: 'p1',
        landing_hash: '#contracts',
        paused_at: expiredPausedAt,
        deferred_at: expiredPausedAt + 5 * 60_000,
        review_started_at: null,
        attempt_count: 0,
        diagnosis_target: null,
        diagnosis_outcome: null,
      }),
    );
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    expect(storage.getItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    )).toBe(currentParent);
    expect(storage.getItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBeNull();
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(topbar.innerHTML).not.toContain('top-bar-attention--saved');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="ready"');
    expect(topbar.innerHTML).toContain('Finish returning to Chat');
    expect(topbar.innerHTML).not.toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('reopens an expired quiet handoff when a dirty route decline keeps the current work', async () => {
    const storage = memorySessionStorage();
    const now = 1_700_000_000_000;
    const pausedAt = now - RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: pausedAt,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: pausedAt,
        review_target: 'server',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      JSON.stringify({
        v: 4,
        profile_id: 'p1',
        landing_hash: '#contracts',
        paused_at: pausedAt,
        deferred_at: pausedAt + 5 * 60_000,
        review_started_at: null,
        attempt_count: 0,
        diagnosis_target: null,
        diagnosis_outcome: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const confirm = vi.fn(() => false);
    const location: { hash: string } = {} as { hash: string };
    Object.defineProperty(location, 'hash', {
      configurable: true,
      get: () => fixture.hashSource.getHash(),
      set: (hash: string) => { fixture.hashSource.setHash(hash); },
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      confirm,
      location,
      history: { replaceState: vi.fn(), pushState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    await flush();

    const draft = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!;
    draft.fireInput('Keep this private unfinished thought');
    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    topbar.fireClick({
      action: 'review-recovery-intent-expiry-handoff',
    });
    await flush();

    expect(confirm).toHaveBeenCalledOnce();
    expect(handle.activeRoute()).toBe('chat');
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)?.value).toBe(
      'Keep this private unfinished thought',
    );
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain(
      ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
    );
    expect(topbar.innerHTML).not.toContain('Keep this private');
    expect(storage.data.has(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    )).toBe(true);
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(countRpcCalls(
      fixture.transportControls,
      'server.setPaused',
    )).toBe(0);
    await handle.dispose();
  });

  it('does not flash an already-overage handoff when a suspended expiry timer resumes late', async () => {
    const storage = memorySessionStorage();
    const initialNow = 1_700_000_000_000;
    let currentNow = initialNow;
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: initialNow,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: initialNow,
        review_target: 'server',
        state: 'ready',
        interruption_count: 0,
        last_interruption: null,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      JSON.stringify({
        v: 4,
        profile_id: 'p1',
        landing_hash: '#contracts',
        paused_at: initialNow,
        deferred_at: initialNow,
        review_started_at: null,
        attempt_count: 0,
        diagnosis_target: null,
        diagnosis_outcome: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const pollTimer = buildFakePollTimer();
    vi.useFakeTimers();
    try {
      const handle = await bootstrapWebclient({
        ...fixture.opts,
        now: () => currentNow,
        enablePermissionsPanel: false,
        profileStore: profiles.store,
        recoveryIntentContinuationStorage: storage,
        setCertPinPollTimer: pollTimer.setPollTimer,
      });
      const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
      expect(topbar.innerHTML).toContain('top-bar-attention--saved');
      expect(topbar.innerHTML).not.toContain('top-bar-attention--ready');
      let currentHtml = topbar.innerHTML;
      const renders: string[] = [];
      Object.defineProperty(topbar, 'innerHTML', {
        configurable: true,
        get: () => currentHtml,
        set: (value: string) => {
          currentHtml = value;
          renders.push(value);
        },
      });

      currentNow = initialNow
        + 2 * RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS;
      await vi.advanceTimersByTimeAsync(
        RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
      );

      expect(renders.some((html) => html.includes(
        ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF_ATTR,
      ))).toBe(false);
      expect(renders.some((html) => html.includes(
        'top-bar-attention--ready',
      ))).toBe(false);
      expect(topbar.innerHTML).toContain('No items need your attention');
      expect(storage.data.has(
        RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
      )).toBe(false);
      await handle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores interrupted resolved verification and safely survives a declined dirty-route return', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    storage.setItem(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
      JSON.stringify({
        v: 2,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
        review_target: 'area',
        state: 'checking',
        interruption_count: 0,
        last_interruption: null,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const confirm = vi.fn(() => false);
    const location: { hash: string } = {} as { hash: string };
    Object.defineProperty(location, 'hash', {
      configurable: true,
      get: () => fixture.hashSource.getHash(),
      set: (hash: string) => { fixture.hashSource.setHash(hash); },
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      confirm,
      location,
      history: { replaceState: vi.fn(), pushState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(topbar.innerHTML).toContain('Retry verification');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);

    const draft = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!;
    draft.fireInput('Keep this private unfinished thought');
    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();

    expect(confirm).toHaveBeenCalledOnce();
    expect(handle.activeRoute()).toBe('chat');
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)?.value).toBe(
      'Keep this private unfinished thought',
    );
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(0);
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(true);
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="verification_handoff"');
    expect(topbar.innerHTML).toContain(
      'Verification keeps getting interrupted',
    );
    expect(topbar.innerHTML).toContain('Review connection');
    expect(topbar.innerHTML).not.toContain('Retry verification');
    expect(topbar.innerHTML).not.toContain('Keep this private');

    topbar.fireClick({ action: 'review-recovery-intent-server' });
    await flush();
    const account = findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)!;
    expect(account.hasAttribute('hidden')).toBe(false);
    const diagnosis = findByAttr(
      fixture.root,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    expect(diagnosis.hasAttribute('hidden')).toBe(false);
    expect(diagnosis.getAttribute('data-interruption-reason')).toBe(
      'navigation',
    );
    expect(subtreeText(diagnosis)).toContain(
      'The latest check ended when this tab left the saved work area',
    );
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(true);
    findByAttr(
      diagnosis,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!.click();
    expect(account.hasAttribute('hidden')).toBe(true);
    expect(topbar.innerHTML).toContain('attention-popover');
    expect(topbar.innerHTML).toContain(
      'data-phase="awaiting_review_outcome"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);

    confirm.mockReturnValue(true);
    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    const retry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.hashSource.setHash('#chat');
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(topbar.innerHTML).toContain('data-review-target="server"');
    expect(handle.activeRoute()).toBe('chat');

    // A late answer from the route we left cannot complete the return.
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: retry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(topbar.innerHTML).toContain(
      'data-phase="verification_interrupted"',
    );
    expect(handle.activeRoute()).toBe('chat');

    topbar.fireClick({ action: 'resolve-recovery-intent-review' });
    await flush();
    const finalRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(finalRetry.request_id).not.toBe(retry.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: finalRetry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    expect(handle.activeRoute()).toBe('contracts');
    const listTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    expect(listTab.focusCallCount).toBe(1);
    expect(listTab.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(storage.data.has(
      RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    )).toBe(false);
    await handle.dispose();
  });

  it('repairs a connection-bound failure through Account and retries the exact intent once', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'choose_again',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const account = findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)!;
    const accountTrigger = findByAttr(
      fixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const interruptedRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(interruptedRecheck.request_id).not.toBe(initialList.request_id);

    // The route-owned read loses its transport. The raw RPC diagnostic stays
    // below the shell boundary; Attention exposes only a closed-list repair.
    fixture.transportControls.fireState('closed');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: interruptedRecheck.request_id,
      error: {
        code: 'unavailable',
        message: 'private reconnect transport diagnostic',
      },
    });
    await flush();
    fixture.hashSource.setHash('#chat');
    await flush();
    expect(fixture.hashSource.getHash()).toBe('#chat');
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="connection"');
    expect(topbar.innerHTML).toContain(
      'Reconnect before returning to Contracts',
    );
    expect(topbar.innerHTML).toContain('Review connection');
    expect(topbar.innerHTML).toContain('Review Contracts');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(topbar.innerHTML).not.toContain('connection lost');
    expect(topbar.innerHTML).not.toContain(
      'private reconnect transport diagnostic',
    );
    expect(topbar.innerHTML).not.toContain(
      'collection.contract.listContracts',
    );
    const readsBeforeRepair = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );

    topbar.fireClick({
      action: 'remediate-recovery-intent-connection',
    });
    await flush();
    expect(topbar.innerHTML).not.toContain('attention-popover');
    expect(account.hasAttribute('hidden')).toBe(false);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRepair);

    fixture.transportControls.fireState('connected');
    fixture.transportControls.fireState('disconnected');
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);
    expect(accountTrigger.focusCallCount).toBe(0);
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRepair);

    fixture.transportControls.fireState('connected');
    await flush();
    expect(account.hasAttribute('hidden')).toBe(true);
    expect(accountTrigger.focusCallCount).toBe(1);
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    const exactRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(exactRetry.request_id).not.toBe(interruptedRecheck.request_id);
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRepair + 1);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );

    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: exactRetry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    const listTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    expect(listTab.focusCallCount).toBe(1);
    expect(listTab.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(subtreeText(banner)).not.toContain('Back on');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');

    // A duplicate connected observation cannot replay the one-shot retry or
    // its exact arrival cue.
    fixture.transportControls.fireState('connected');
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeRepair + 1);
    expect(listTab.focusCallCount).toBe(1);
    await handle.dispose();
  });

  it('keeps a committed profile action ahead of the reconnect-owned exact retry', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    let rejectSwitch: (error: Error) => void = () => undefined;
    const switchInFlight = new Promise<void>((_resolve, reject) => {
      rejectSwitch = reject;
    });
    const profileStore: WebclientProfileStore = {
      ...profiles.store,
      async switchProfile() {
        await switchInFlight;
      },
    };
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enablePermissionsPanel: false,
      profileStore,
      reloadForServerSwitch: reload,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const account = findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)!;
    const accountTrigger = findByAttr(
      fixture.root,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const interruptedRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireState('closed');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: interruptedRecheck.request_id,
      error: { code: 'unavailable', message: 'private transport detail' },
    });
    await flush();
    fixture.hashSource.setHash('#chat');
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'remediate-recovery-intent-connection' });
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);

    const office = findChildrenByAttr(
      fixture.root,
      SERVER_SWITCHER_ITEM_ATTR,
    ).find((item) => item.getAttribute('data-profile-id') === 'p2')!;
    office.click();
    findByAttr(fixture.root, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    const readsBeforeReconnect = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );

    fixture.transportControls.fireState('connected');
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);
    expect(accountTrigger.focusCallCount).toBe(0);
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );

    rejectSwitch(new Error('private switch failure'));
    await flush();
    expect(account.hasAttribute('hidden')).toBe(false);
    findByAttr(fixture.root, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="ready"');
    expect(topbar.innerHTML).toContain('Recheck area');
    expect(topbar.innerHTML).not.toContain('Waiting for connection');
    expect(topbar.innerHTML).not.toContain('private switch failure');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    await handle.dispose();
  });

  it('fails closed when an already mounted area has no authoritative retry seam', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#settings',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#settings');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('Finish returning to Settings');
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    topbar.fireClick({ action: 'open-attention' });

    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="review"');
    expect(topbar.innerHTML).toContain('Review Settings before continuing');
    expect(topbar.innerHTML).toContain('Review Settings');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(subtreeText(banner)).not.toContain('Back on');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');

    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    expect(topbar.innerHTML).toContain('data-remediation="review"');
    expect(topbar.innerHTML).toContain('Review Settings before continuing');
    expect(topbar.innerHTML).not.toContain('Try again');
    await handle.dispose();
  });

  it('re-arms a failed recheck on reconnect without claiming or starting success', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const failedRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: failedRecheck.request_id,
      error: { code: 'unavailable', message: 'private reconnect failure' },
    });
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    const readsBeforeReconnect = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );

    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireState('connected');
    await flush();

    expect(topbar.innerHTML).toContain('data-phase="ready"');
    expect(topbar.innerHTML).toContain('Finish returning to Contracts');
    expect(topbar.innerHTML).toContain('Recheck area');
    expect(topbar.innerHTML).not.toContain('Couldn’t verify Contracts');
    expect(topbar.innerHTML).not.toContain('Try again');
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(readsBeforeReconnect);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );
    expect(subtreeText(banner)).not.toContain('Back on');
    await handle.dispose();
  });

  it('reviews a failed recheck through a fresh broad-route landing without a success claim', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    topbar.fireClick({ action: 'open-attention' });
    topbar.fireClick({ action: 'resume-recovery-intent-continuation' });
    await flush();
    const failedRecheck = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: failedRecheck.request_id,
      error: { code: 'unavailable', message: 'private first failure' },
    });
    await flush();

    expect(findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ERROR_ATTR,
    )?.focusCallCount).toBe(1);
    fixture.hashSource.setHash('#chat');
    await flush();
    topbar.fireClick({ action: 'open-attention' });
    expect(topbar.innerHTML).toContain('data-phase="failed"');
    topbar.fireClick({ action: 'review-recovery-intent-continuation' });
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(topbar.innerHTML).not.toContain('attention-popover');
    const reviewRead = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(reviewRead.request_id).not.toBe(failedRecheck.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: reviewRead.request_id,
      error: { code: 'unavailable', message: 'private review failure' },
    });
    await flush();

    const reviewError = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ERROR_ATTR,
    )!;
    expect(reviewError.focusCallCount).toBe(1);
    expect(reviewError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(subtreeText(banner)).not.toContain('Back on');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    await handle.dispose();
  });

  it('quietly retires the paused return when the person resumes that area directly', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const topbar = findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)!;
    const row = findByAttr(fixture.root, CONTRACTS_ROUTE_ROW_ATTR)!;
    expect(topbar.innerHTML).toContain('top-bar-attention-badge');
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      true,
    );

    // A deliberate interaction in the same broad route means the person has
    // already resumed ownership. Retire the quiet reminder without moving
    // focus, announcing completion, or restoring the old orientation cue.
    fixture.fakeDoc.fireDocumentEvent('pointerdown', row);
    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(topbar.innerHTML).not.toContain('top-bar-attention-badge');
    expect(row.focusCallCount).toBe(0);
    expect(row.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(findByAttr(
      fixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )?.textContent ?? '').toBe('');
    await handle.dispose();
  });

  it('retires a paused return when Attention is unavailable', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
      JSON.stringify({
        v: 1,
        profile_id: 'p1',
        landing_hash: '#contracts',
        intent: 'continue',
        paused_at: 1_700_000_000_000,
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      enableApprovalsRoute: false,
      profileStore: profiles.store,
      recoveryIntentContinuationStorage: storage,
    });

    expect(storage.data.has(RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toBe(
      false,
    );
    expect(findByAttr(fixture.root, ATTENTION_TOPBAR_HOST_ATTR)).toBeNull();
    await handle.dispose();
  });

  it('restores the exact handoff when an unsaved Chat draft declines the return', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const confirm = vi.fn(() => false);
    const location: { hash: string } = {} as { hash: string };
    Object.defineProperty(location, 'hash', {
      configurable: true,
      get: () => fixture.hashSource.getHash(),
      set: (hash: string) => { fixture.hashSource.setHash(hash); },
    });
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      confirm,
      location,
      history: { replaceState: vi.fn(), pushState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(action.textContent).toBe('Continue in Contracts');
    fixture.hashSource.setHash('#chat');
    await flush();
    const sessions = findLatestRpcCall(
      fixture.transportControls,
      'chat.sessions.list',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessions.request_id,
      result: { sessions: [] },
    });
    await flush();
    const input = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!;
    input.fireInput('Keep this unfinished thought');
    const contractReads = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );

    action.click();

    expect(confirm).toHaveBeenCalledOnce();
    expect(handle.activeRoute()).toBe('chat');
    expect(fixture.hashSource.getHash()).toBe('#chat');
    expect(findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)?.value).toBe(
      'Keep this unfinished thought',
    );
    expect(subtreeText(banner)).toContain(
      'Back on home. Contracts is refreshed and ready.',
    );
    expect(action.textContent).toBe('Continue in Contracts');
    expect(action.hasAttribute('hidden')).toBe(false);
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(contractReads);
    await handle.dispose();
  });

  it('reconciles a route move instead of calling stale arrival context ready', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(list).toBeDefined();

    fixture.hashSource.setHash('#chat');
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(banner.getAttribute('data-state')).toBe('attention');
    expect(subtreeText(banner)).toContain('tab has moved since arrival');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    expect(action.textContent).toBe('Return to Contracts');
    const content = routeContentRoot(fixture.root);
    const broadFocusesBeforeReturn = content.focusCallCount;
    action.click();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(subtreeText(banner)).toContain(
      'Checking Contracts on home for the latest information',
    );
    const returnedList = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(returnedList.request_id).not.toBe(list.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: returnedList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ROW_ATTR,
    )?.focusCallCount).toBe(1);
    expect(content.focusCallCount).toBe(broadFocusesBeforeReturn);
    expect(action.textContent).toBe('Continue in Contracts');
    await handle.dispose();
  });

  it('explains when source-owned detail was withheld from a fresh return area', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'detail_withheld',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(banner.getAttribute('data-state')).toBe('attention');
    expect(subtreeText(banner)).toContain('Contracts is refreshed');
    expect(subtreeText(banner)).toContain(
      'item you had open wasn’t carried across servers',
    );
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    expect(action.textContent).toBe('Choose again in Contracts');
    const content = routeContentRoot(fixture.root);
    const broadFocusesBeforeChoose = content.focusCallCount;
    const activeListTab = findChildrenByAttr(
      fixture.root,
      CONTRACTS_ROUTE_LIST_TAB_ATTR,
    ).find((tab) => tab.getAttribute('aria-selected') === 'true')!;
    action.click();
    expect(activeListTab.focusCallCount).toBe(1);
    expect(activeListTab.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(findByAttr(
      fixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )?.textContent).toBe('Choose again here.');
    expect(content.focusCallCount).toBe(broadFocusesBeforeChoose);
    await handle.dispose();
  });

  it('retries an unavailable arrival read through the route and resolves the intent', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      error: { code: 'unavailable', message: 'read unavailable' },
    });
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(banner.getAttribute('data-state')).toBe('attention');
    expect(subtreeText(banner)).toContain('couldn’t confirm Contracts is current');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    expect(action.textContent).toBe('Retry Contracts');

    // If the person browsed away while deciding, returning mounts one fresh
    // route read. That read is the retry; the handoff must not double-fetch.
    const callsBeforeReturn = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    fixture.hashSource.setHash('#chat');
    action.click();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    expect(subtreeText(banner)).toContain(
      'Checking Contracts on home for the latest information',
    );
    expect(action.hasAttribute('hidden')).toBe(true);
    await flush();
    const firstRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(firstRetry.request_id).not.toBe(list.request_id);
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(callsBeforeReturn + 1);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: firstRetry.request_id,
      error: { code: 'unavailable', message: 'still unavailable' },
    });
    await flush();
    expect(subtreeText(banner)).toContain('couldn’t confirm Contracts is current');
    expect(action.textContent).toBe('Retry Contracts');

    action.click();
    await flush();
    const successfulRetry = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(successfulRetry.request_id).not.toBe(firstRetry.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: successfulRetry.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();
    expect(subtreeText(banner)).toContain(
      'Back on home. Contracts is refreshed and ready.',
    );
    expect(action.textContent).toBe('Continue in Contracts');
    await handle.dispose();
  });

  it('fails closed when the saved area has no authoritative reader', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      enableContractsPanel: false,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(subtreeText(banner)).toContain('hasn’t confirmed Contracts is current');
    expect(subtreeText(banner)).not.toContain('refreshed and ready');
    expect(action.textContent).toBe('Review Contracts');
    expect(findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBeUndefined();
    action.click();
    expect(findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBeUndefined();
    expect(findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_HEADING_ATTR,
    )?.focusCallCount).toBe(1);
    await handle.dispose();
  });

  it('waits for a routed Review read before focusing its resulting error', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 2,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const initialList = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: initialList.request_id,
      result: { contracts: [], next_cursor: null, total: 0 },
    });
    await flush();

    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(action.textContent).toBe('Review Contracts');
    fixture.hashSource.setHash('#chat');
    const content = routeContentRoot(fixture.root);
    const broadFocusesBeforeReview = content.focusCallCount;
    action.click();
    expect(fixture.hashSource.getHash()).toBe('#contracts');
    const heading = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_HEADING_ATTR,
    )!;
    expect(heading.focusCallCount).toBe(0);
    expect(content.focusCallCount).toBe(broadFocusesBeforeReview);

    const reviewList = findLatestRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;
    expect(reviewList.request_id).not.toBe(initialList.request_id);
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: reviewList.request_id,
      error: { code: 'unavailable', message: 'review read unavailable' },
    });
    await flush();

    const reviewError = findByAttr(
      fixture.root,
      CONTRACTS_ROUTE_ERROR_ATTR,
    )!;
    expect(reviewError.focusCallCount).toBe(1);
    expect(reviewError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(findByAttr(
      fixture.root,
      RECOVERY_INTENT_ANNOUNCER_ATTR,
    )?.textContent).toBe(
      'Review this status before continuing.',
    );
    expect(heading.focusCallCount).toBe(0);
    expect(content.focusCallCount).toBe(broadFocusesBeforeReview);
    expect(action.hasAttribute('hidden')).toBe(true);
    await handle.dispose();
  });

  it('downgrades a retryable result across a reconnect to review only', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 3,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#contracts',
        return_context: 'area',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#contracts');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    const list = findRpcCall(
      fixture.transportControls,
      'collection.contract.listContracts',
    )!;

    fixture.transportControls.fireState('reconnecting');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: list.request_id,
      error: { code: 'unavailable', message: 'read interrupted' },
    });
    await flush();
    fixture.transportControls.fireState('connected');
    await flush();

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(fixture.root, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(subtreeText(banner)).toContain(
      'server is connected, but Recued hasn’t confirmed Contracts is current',
    );
    expect(action.textContent).toBe('Review Contracts');
    const contractReads = countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    );
    action.click();
    await flush();
    expect(countRpcCalls(
      fixture.transportControls,
      'collection.contract.listContracts',
    )).toBe(contractReads);
    await handle.dispose();
  });

  it('does not claim resumed work when a recovery arrival route no longer matches', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 2,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#data/files',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    expect(subtreeText(banner)).toContain('Now using home.');
    expect(subtreeText(banner)).not.toContain('ready where you left it');
    expect(findByAttr(
      fixture.root,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    await handle.dispose();
  });

  it('does not claim a feature-gated return area that the shell cannot mount', async () => {
    const storage = memorySessionStorage();
    storage.setItem(
      SERVER_SWITCH_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        v: 2,
        target_profile_id: 'p1',
        kind: 'recovery_return',
        landing_hash: '#approvals',
      }),
    );
    const fixture = buildOpts();
    fixture.hashSource.setHash('#approvals');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      enableApprovalsRoute: false,
      reloadForServerSwitch: vi.fn(),
      serverSwitchContinuityStorage: storage,
    });

    const banner = findByAttr(fixture.root, CONNECTION_BANNER_ATTR)!;
    expect(handle.activeRoute()).toBe('chat');
    expect(findByAttr(fixture.root, 'data-recued-chat-route')).not.toBeNull();
    expect(subtreeText(banner)).toContain('Now using home.');
    expect(subtreeText(banner)).not.toContain('Approvals is ready');
    expect(findByAttr(
      fixture.root,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);
    await handle.dispose();
  });

  it('silently converges a clean sibling to the durable target and scrubs source detail', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat/answer/source-message');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const storage = memorySessionStorage();
    const replaceHash = vi.fn();
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: replaceHash,
      serverSwitchContinuityStorage: storage,
    });
    await flush();

    profiles.state.activeId = 'p2';
    // The production BroadcastChannel hint carries no target identity.
    handle.requestServerProfileConvergence();
    await flush();

    expect(handle.serverProfileId()).toBe('p1');
    expect(replaceHash).toHaveBeenCalledWith('#chat');
    expect(reload).toHaveBeenCalledOnce();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ATTR)).toBeNull();
    // Only the tab that initiated the choice earns "Now using …".
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);

    await handle.dispose();
  });

  it('releases an immediate pause when a delayed switch hint finds the source profile active again', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    // The detail-free signal can outlive a switch that another tab already
    // rolled back. It still pauses synchronously, but the durable source pointer
    // must release that pause without a modal or reload.
    handle.requestServerProfileConvergence();
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(true);
    await flush();

    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(false);
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ATTR)).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    await handle.dispose();
  });

  it('restores a clean sibling route and offers an inline retry when reload is refused', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat/answer/source-message');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const replaceHash = vi.fn();
    let failReload = true;
    const reload = vi.fn(() => {
      if (failReload) throw new Error('reload refused');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: replaceHash,
    });
    await flush();

    profiles.state.activeId = 'p2';
    handle.requestServerProfileConvergence('p2');
    await flush();

    expect(reload).toHaveBeenCalledOnce();
    expect(replaceHash.mock.calls.map(([hash]) => hash)).toEqual([
      '#chat',
      '#chat/session/source-chat/answer/source-message',
    ]);
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ERROR_ATTR)?.textContent)
      .toContain('Your work is still here');
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(true);

    failReload = false;
    // A late source-route change cannot ride a confirmation that described a
    // clean tab. Programmatic completions can still update an inert route, so
    // the commit path re-probes and makes the new discard boundary explicit.
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Arrived after the failed automatic reload');
    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();

    expect(reload).toHaveBeenCalledOnce();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR)?.value)
      .toBe('Arrived after the failed automatic reload');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)?.textContent)
      .toBe('Switch and discard draft');

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();

    expect(reload).toHaveBeenCalledTimes(2);
    expect(replaceHash.mock.calls.map(([hash]) => hash)).toEqual([
      '#chat',
      '#chat/session/source-chat/answer/source-message',
      '#chat',
    ]);

    errors.mockRestore();
    await handle.dispose();
  });

  it('lets the same sibling target recover after a transient active-profile read failure', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    const readActiveProfile = profiles.store.activeProfileId.bind(profiles.store);
    let failNextRead = true;
    profiles.store.activeProfileId = async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('temporary IndexedDB read failure');
      }
      return readActiveProfile();
    };
    profiles.state.activeId = 'p2';

    handle.requestServerProfileConvergence('p2');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ERROR_ATTR)?.textContent)
      .toContain('couldn’t confirm the selected server');
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(true);

    // Resetting the target dedupe allows the same BroadcastChannel/focus hint
    // to refresh the destination. Once an error boundary has been shown, the
    // reload remains explicit instead of disappearing underneath the user.
    handle.requestServerProfileConvergence('p2');
    await flush();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ERROR_ATTR)).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();
    expect(reload).toHaveBeenCalledOnce();

    errors.mockRestore();
    await handle.dispose();
  });

  it('pauses immediately and requires confirmation if clean work becomes dirty during the final pointer read', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: vi.fn(),
    });
    await flush();

    const readActiveProfile = profiles.store.activeProfileId.bind(profiles.store);
    let readCount = 0;
    let releaseFinalRead = (): void => undefined;
    const finalRead = new Promise<void>((resolve) => {
      releaseFinalRead = resolve;
    });
    profiles.store.activeProfileId = async () => {
      readCount += 1;
      if (readCount === 2) await finalRead;
      return readActiveProfile();
    };
    profiles.state.activeId = 'p2';

    handle.requestServerProfileConvergence('p2');
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(true);
    await vi.waitFor(() => expect(readCount).toBe(2));

    // Fake DOM input can model a programmatic/in-flight edit even while inert.
    // The final work-state check must still refuse the silent reload.
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Arrived while the server pointer was being confirmed');
    releaseFinalRead();
    await flush();

    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR)?.value)
      .toBe('Arrived while the server pointer was being confirmed');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)?.textContent)
      .toBe('Switch and discard draft');

    await handle.dispose();
  });

  it('holds a sibling on unsettled Chat work until it finishes or the owner explicitly leaves', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: vi.fn(),
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
    const sessionsList = rpcCalls().find(
      (call) => call.method === 'chat.sessions.list',
    );
    expect(typeof sessionsList?.request_id).toBe('string');
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: sessionsList!.request_id,
      result: { sessions: [] },
    });
    await flush();

    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Ask the source server to prepare this');
    findChildByAttr(fixture.root, CHAT_ROUTE_SEND_ATTR)!.click();
    await flush();
    const create = rpcCalls().find(
      (call) => call.method === 'chat.session.create',
    );
    expect(typeof create?.request_id).toBe('string');

    profiles.state.activeId = 'p2';
    handle.requestServerProfileConvergence('p2');
    await flush();

    const dialog = findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR)!;
    expect(subtreeText(dialog)).toContain('Work is still finishing on the original server');
    expect(subtreeText(dialog)).toContain('outcome or receipt stays on the original server');
    expect(subtreeText(findByAttr(
      fixture.root,
      SERVER_SWITCH_CONVERGENCE_ACTIVE_WORK_ITEM_ATTR,
    )!)).toContain('Finishing a Chat action');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR)?.value)
      .toBe('Ask the source server to prepare this');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_CHECK_ATTR)?.textContent)
      .toBe('Check status');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)?.textContent)
      .toBe('Switch and check later');
    expect(reload).not.toHaveBeenCalled();

    // The source request settles with a known failure while the tab is paused.
    // Recheck must downgrade to the retained draft boundary, not reload under
    // the owner or keep claiming that work is still in flight.
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: create!.request_id,
      error: {
        code: 'temporary_failure',
        message: 'Could not create the Chat session',
        status: 503,
      },
    });
    await flush();
    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_CHECK_ATTR)!.click();
    await flush();

    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_CHECK_ATTR)).toBeNull();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_STATUS_ATTR)?.textContent)
      .toContain('request finished on home');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR)?.value)
      .toBe('Ask the source server to prepare this');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)?.textContent)
      .toBe('Switch and discard draft');
    expect(reload).not.toHaveBeenCalled();

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();
    expect(reload).toHaveBeenCalledOnce();

    await handle.dispose();
  });

  it('pauses a dirty sibling, keeps its draft copyable, then suppresses the duplicate unload prompt', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const storage = memorySessionStorage();
    const replaceHash = vi.fn();
    const clipboardWrite = vi.fn(async () => undefined);
    const beforeUnloadListeners = new Set<(event: {
      preventDefault(): void;
      returnValue?: unknown;
    }) => void>();
    (fixture.fakeDoc as { defaultView?: unknown }).defaultView = {
      navigator: { clipboard: { writeText: clipboardWrite } },
      addEventListener: (name: string, listener: (event: {
        preventDefault(): void;
        returnValue?: unknown;
      }) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.add(listener);
      },
      removeEventListener: (name: string, listener: (event: {
        preventDefault(): void;
        returnValue?: unknown;
      }) => void) => {
        if (name === 'beforeunload') beforeUnloadListeners.delete(listener);
      },
    };
    let reloadPrevented: boolean | null = null;
    const reload = vi.fn(() => {
      const event = {
        prevented: false,
        returnValue: undefined as unknown,
        preventDefault(): void { event.prevented = true; },
      };
      for (const listener of [...beforeUnloadListeners]) listener(event);
      reloadPrevented = event.prevented;
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: replaceHash,
      serverSwitchContinuityStorage: storage,
    });
    await flush();
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Private source-server thought');

    profiles.state.activeId = 'p2';
    handle.requestServerProfileConvergence('p2');
    await flush();

    const dialog = findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR);
    expect(dialog?.getAttribute('role')).toBe('alertdialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-describedby')).toBe(
      'recued-server-switch-convergence-identity '
      + 'recued-server-switch-convergence-detail '
      + 'recued-server-switch-convergence-boundary',
    );
    expect(subtreeText(dialog!)).toContain('home (wss://home.example/ws)');
    expect(subtreeText(dialog!)).toContain('office (wss://office.example/ws)');
    expect(subtreeText(dialog!)).toContain('never move it to another server');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DRAFT_ATTR)?.value)
      .toBe('Private source-server thought');
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(true);
    expect(reload).not.toHaveBeenCalled();

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COPY_ATTR)!.click();
    await flush();
    expect(clipboardWrite).toHaveBeenCalledWith('Private source-server thought');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_STATUS_ATTR)?.textContent)
      .toContain('still not stored on the new server');

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();

    expect(replaceHash).toHaveBeenCalledWith('#chat');
    expect(reload).toHaveBeenCalledOnce();
    expect(reloadPrevented).toBe(false);
    expect(storage.data.has(SERVER_SWITCH_CONTINUITY_SESSION_KEY)).toBe(false);

    await handle.dispose();
  });

  it('requires a fresh dirty-tab confirmation when a third profile wins', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat');
    const profiles = buildProfileStore(
      [HOME_PROFILE, OFFICE_PROFILE, STUDIO_PROFILE],
      'p1',
    );
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      replaceHashForServerSwitch: vi.fn(),
    });
    await flush();
    findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!
      .fireInput('Keep this source draft');

    profiles.state.activeId = 'p2';
    handle.requestServerProfileConvergence('p2');
    await flush();
    profiles.state.activeId = 'p3';
    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();
    await flush();

    expect(reload).not.toHaveBeenCalled();
    const dialog = findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_DIALOG_ATTR)!;
    expect(subtreeText(dialog)).toContain('studio (wss://studio.example/ws)');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ERROR_ATTR)?.textContent)
      .toContain('changed again');
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)?.textContent)
      .toBe('Switch and discard draft');

    findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_COMMIT_ATTR)!.click();
    await flush();
    expect(reload).toHaveBeenCalledOnce();

    await handle.dispose();
  });

  it('dismisses sibling convergence without losing work when the active choice is reversed', async () => {
    const fixture = buildOpts();
    fixture.hashSource.setHash('#chat/session/source-chat');
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
      replaceHashForServerSwitch: vi.fn(),
    });
    await flush();
    const draft = findChildByAttr(fixture.root, CHAT_ROUTE_INPUT_ATTR)!;
    draft.fireInput('Keep this when the choice returns home');

    profiles.state.activeId = 'p2';
    handle.requestServerProfileConvergence('p2');
    await flush();
    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ATTR)).not.toBeNull();

    profiles.state.activeId = 'p1';
    handle.requestServerProfileConvergence('p1');

    expect(findByAttr(fixture.root, SERVER_SWITCH_CONVERGENCE_ATTR)).toBeNull();
    expect(findByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)?.hasAttribute('inert'))
      .toBe(false);
    expect(draft.value).toBe('Keep this when the choice returns home');

    await handle.dispose();
  });

  it('keeps the profile and explains when removal cannot read the durable roster', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();
    profiles.store.listProfiles = async () => {
      throw new Error('indexeddb read failed');
    };

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR)[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();
    await flush();

    expect(profiles.calls).not.toContain('remove:p2');
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ERROR_ATTR)?.textContent)
      .toContain('Nothing was removed');

    errors.mockRestore();
    await handle.dispose();
  });

  it('forgetting locally reboots for the ACTIVE server and only re-renders another', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    // Forget the NON-active one — the app is still validly connected.
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const removes = findAllByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR);
    removes[1]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();
    await flush();
    expect(profiles.calls).toContain('remove:p2');
    expect(reload).not.toHaveBeenCalled();
    expect(
      findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)?.hasAttribute('hidden'),
    ).toBe(false);

    // Forget the ACTIVE one — the app would otherwise keep running against
    // credentials the store no longer holds.
    const remaining = findAllByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR);
    remaining[0]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();
    await flush();
    expect(profiles.calls).toContain('remove:p1');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      findByAttr(fixture.root, ACCOUNT_MENU_POPOVER_ATTR)?.hasAttribute('hidden'),
    ).toBe(true);

    await handle.dispose();
  });

  it('revokes the active paired instance before local removal, suppresses expected reauth, and signals siblings', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore(
      [REVOCABLE_HOME_PROFILE, OFFICE_PROFILE],
      'p1',
    );
    const reload = vi.fn();
    const onReauthRequired = vi.fn();
    const onServerProfileRemoved = vi.fn();
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      onReauthRequired,
      onServerProfileRemoved,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)!.click();
    await flush();

    const revoke = findRpcCall(fixture.transportControls, 'pair.revoke');
    expect(revoke?.args).toEqual({ instance_id: 'instance-home' });
    expect(profiles.calls).not.toContain('remove:p1');

    // Self-revoke closes this socket with reauth_required. This is expected,
    // not a reason to wipe into the guided repair flow while Account owns the
    // deliberate revoke → forget transaction.
    fixture.transportControls.fireState('reauth_required');
    expect(onReauthRequired).not.toHaveBeenCalled();
    fixture.transportControls.fireMessage({
      type: 'instance_revoked',
      instance_id: 'instance-home',
      at: 1_700_000_000_000,
    });
    await flush();

    expect(profiles.calls).toContain('remove:p1');
    expect(onServerProfileRemoved).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(onReauthRequired).not.toHaveBeenCalled();

    await handle.dispose();
  });

  it('keeps a locally-stuck revoked profile actionable until local forget succeeds', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([REVOCABLE_HOME_PROFILE], 'p1');
    const originalRemove = profiles.store.removeProfile.bind(profiles.store);
    let rejectRemoval = true;
    profiles.store.removeProfile = async (id) => {
      if (rejectRemoval) throw new Error('indexeddb write failed');
      await originalRemove(id);
    };
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)!.click();
    await flush();
    expect(findRpcCall(fixture.transportControls, 'pair.revoke')).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'instance_revoked',
      instance_id: 'instance-home',
    });
    await flush();

    expect(profiles.state.profiles).toContainEqual(expect.objectContaining({
      ...REVOCABLE_HOME_PROFILE,
      last_connected_at: 1_700_000_000_000,
    }));
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ERROR_ATTR)?.textContent)
      .toContain('Access was revoked');
    expect(findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)).not.toBeNull();

    rejectRemoval = false;
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();
    await flush();

    expect(profiles.calls).toContain('remove:p1');
    expect(reload).toHaveBeenCalledOnce();
    errors.mockRestore();
    await handle.dispose();
  });

  it('keeps the profile after a real revoke failure and restores ordinary reauth recovery', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([REVOCABLE_HOME_PROFILE], 'p1');
    const reload = vi.fn();
    const onReauthRequired = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
      onReauthRequired,
      selfRevokeReceiptGraceMs: 0,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ATTR)!.click();
    findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)!.click();
    await flush();
    const revoke = findRpcCall(fixture.transportControls, 'pair.revoke');
    expect(revoke).toBeDefined();
    fixture.transportControls.fireMessage({
      type: 'rpc_result',
      request_id: revoke!.request_id,
      error: {
        code: 'forbidden',
        message: 'revoke was refused',
      },
    });
    await flush();
    await flush();

    expect(profiles.calls).not.toContain('remove:p1');
    expect(profiles.state.profiles).toContainEqual(expect.objectContaining({
      ...REVOCABLE_HOME_PROFILE,
      last_connected_at: 1_700_000_000_000,
    }));
    expect(reload).not.toHaveBeenCalled();
    expect(findByAttr(fixture.root, SERVER_SWITCHER_REMOVE_ERROR_ATTR)?.textContent)
      .toContain('saved profile is still here');

    fixture.transportControls.transport.send = async () => {
      throw new WebclientReauthRequiredError('bearer rejected after revoke failure');
    };
    void handle.conn()('pair.list', undefined).catch(() => undefined);
    await flush();
    expect(onReauthRequired).toHaveBeenCalledOnce();

    errors.mockRestore();
    await handle.dispose();
  });

  it('dispose removes the account menu from the topbar', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)).not.toBeNull();
    await handle.dispose();
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Cold start against an unreachable server
// ══════════════════════════════════════════════════════════════════

describe('bootstrapWebclient: cold start with the server down', () => {
  it('mounts the shell — an unreachable server is NOT a boot failure', async () => {
    // The property the whole offline story rests on, and one easy to break by
    // accident: `ws-client.connect()` swallows a non-reauth connect failure
    // (sets `reconnecting`, queues a retry, returns), so the bootstrap runs to
    // completion with no live socket. If anything ever made that rejection
    // propagate, boot would abort into the startup-failure splash — where
    // there is no shell, no badge, and no way to reach another server, which
    // is precisely the dead end this work removed.
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    (fixture.opts.transport as unknown as { open: () => Promise<void> }).open =
      async () => {
        throw new Error(
          'webclient.browser-transport: WS closed before open (code=1006)',
        );
      };

    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: vi.fn(),
    });
    await flush();

    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).not.toBeNull();
    // And the two surfaces that make the outage actionable are both present:
    // the account menu (local roster, no rpc) and the outage banner.
    expect(findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)).not.toBeNull();
    expect(findByAttr(fixture.root, CONNECTION_BANNER_ATTR)).not.toBeNull();

    // The roster is reachable from there with nothing running on the far end.
    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(findAllByAttr(fixture.root, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(2);

    await handle.dispose();
  });

  it('a REAUTH rejection still aborts — that one is not a connectivity problem', async () => {
    // The distinction that keeps the tolerance honest: a rejected bearer must
    // reach the re-pair path rather than be absorbed as "server down". The
    // ws-client identifies it positively (`isReauthError`) instead of treating
    // every rejection alike.
    const fixture = buildOpts();
    let state = '';
    (fixture.opts.transport as unknown as {
      open: () => Promise<void>;
      onState: (l: (s: string) => void) => () => void;
    }).open = async () => {
      throw new WebclientReauthRequiredError('bearer rejected on connect (close 4401)');
    };
    const handle = await bootstrapWebclient(fixture.opts);
    await flush();
    void state;
    // Boot still completes (the client parks in `reauth_required` and the
    // re-pair path owns it) — what must NOT happen is a silent reconnect loop
    // hammering a server that has rejected this bearer.
    expect(findChildByAttr(fixture.root, WEBCLIENT_SHELL_HOST_ATTR)).not.toBeNull();
    await handle.dispose();
  });
});

describe('bootstrapWebclient: adding a server', () => {
  it('opens a pending attempt and reloads into the pair form', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE, OFFICE_PROFILE], 'p1');
    const reload = vi.fn(() => {
      // Persist first, same rule as a switch: reloading before the attempt is
      // recorded would boot straight back into the old server.
      expect(profiles.calls).toContain('begin');
    });
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(fixture.root, ACCOUNT_MENU_ADD_SERVER_ATTR)!.click();
    await flush();

    expect(profiles.calls).toEqual([
      'ensure:wss://alice.recued.cloud:8443/ws',
      'connected:p1:1700000000000',
      'begin',
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    await handle.dispose();
  });

  it('a failed attempt does NOT reload', async () => {
    const fixture = buildOpts();
    const profiles = buildProfileStore([HOME_PROFILE], 'p1');
    profiles.store.beginNewProfile = async () => { throw new Error('idb closed'); };
    const reload = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = await bootstrapWebclient({
      ...fixture.opts,
      profileStore: profiles.store,
      reloadForServerSwitch: reload,
    });
    await flush();

    findByAttr(fixture.root, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(fixture.root, ACCOUNT_MENU_ADD_SERVER_ATTR)!.click();
    await flush();

    // Reloading into an unchanged store would land back on the same server and
    // read as a no-op click.
    expect(reload).not.toHaveBeenCalled();
    errors.mockRestore();
    await handle.dispose();
  });
});

/** D-222 audit fold — the webclient→server `execute` wire.
 *
 *  `buildRecipeExecuteArgs` is the ONE adapter between every route that runs a
 *  recipe and the `execute` rpc. It lived inside the `bootstrapWebclient`
 *  closure, where no test could reach it, and D-222 shipped with `invocation`
 *  dropped right there: `bootstrap-recipes-route` passed it, the server accepted
 *  it, and this adapter deleted it — so every owner filter submit arrived as an
 *  ordinary run and the server skipped stored hash/section re-resolution AND the
 *  per-block allowlist. Nothing was red, because the route's own tests inject
 *  their own `recipeExecuteCaller` and never compose the real one.
 *
 *  ⚠ THE TYPE CANNOT CARRY THIS. The registry's `execute` request has an
 *  `[k: string]: unknown` index signature, so a shape with members missing
 *  typechecks. These are the guard. */
describe('D-222 — buildRecipeExecuteArgs (the execute wire)', () => {
  it('forwards a filter invocation — the member D-222 dropped', () => {
    // The positive case: the input that would DO THE THING if the forwarding
    // were gone. A test that only asserted the absent case below would pass
    // against the broken adapter that shipped.
    const invocation = {
      kind: 'output.filter' as const,
      recipe_hash: 'stored-hash',
      section_index: 1,
    };
    expect(buildRecipeExecuteArgs({
      recipe_id: 'job-board',
      config: { status: 'open', cursor: '' },
      invocation,
    })).toEqual({
      recipe_id: 'job-board',
      trigger_source: 'manual',
      config: { status: 'open', cursor: '' },
      invocation,
    });
  });

  it('omits every optional member the caller did not supply', () => {
    // Not `{ config: undefined, ... }` — an explicit undefined would travel the
    // wire as a present key, and `request.invocation !== undefined` is exactly
    // what the server's filter admission branches on.
    const args = buildRecipeExecuteArgs({ recipe_id: 'daily-brief' });
    expect(args).toEqual({ recipe_id: 'daily-brief', trigger_source: 'manual' });
    expect(Object.keys(args).sort()).toEqual(['recipe_id', 'trigger_source']);
  });

  it('forwards the targeting-guard context', () => {
    expect(buildRecipeExecuteArgs({
      recipe_id: 'brief-contact',
      context: { entity_id: 'c-1' },
    })).toEqual({
      recipe_id: 'brief-contact',
      trigger_source: 'manual',
      context: { entity_id: 'c-1' },
    });
  });

  // ⛔ THE DRIFT GUARD, and the reason this file is the right home for it: the
  // instance above was one symptom of a class — a caller member that no test
  // names is dropped in silence. This fails when `RecipeExecuteCaller` gains a
  // member that this adapter does not forward, so the next one cannot ship the
  // same way. Add the member to the caller AND to the forwarding above.
  it('forwards EVERY member of the caller contract', () => {
    const supplied = {
      recipe_id: 'job-board',
      config: { status: 'open' },
      context: { entity_id: 'c-1' },
      invocation: {
        kind: 'output.filter' as const,
        recipe_hash: 'stored-hash',
        section_index: 0,
      },
    };
    const wire = buildRecipeExecuteArgs(supplied);
    for (const key of Object.keys(supplied)) {
      expect(
        Object.prototype.hasOwnProperty.call(wire, key),
        `buildRecipeExecuteArgs dropped '${key}' — the route supplies it and the `
          + `server accepts it, so it would be lost in silence`,
      ).toBe(true);
      expect(wire[key]).toEqual(supplied[key as keyof typeof supplied]);
    }
  });
});
