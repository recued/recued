/** D-174 — Settings -> Account binding touchpoint. */

import { describe, expect, it, vi } from 'vitest';
import type {
  AccountBindResult,
  AccountBindingStatusResponse,
  AccountBindingSummary,
  AccountUnbindResult,
  ProConvenienceItem,
  ProConvenienceItemState,
  ProConvenienceStatusResponse,
} from '@recued/contracts';

import {
  ACCOUNT_BINDING_ACTION_MESSAGE_ATTR,
  ACCOUNT_BINDING_CANCEL_REBIND_ATTR,
  ACCOUNT_BINDING_CANCEL_UNBIND_ATTR,
  ACCOUNT_BINDING_CONNECT_ATTR,
  ACCOUNT_BINDING_CONFIRM_REBIND_ATTR,
  ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR,
  ACCOUNT_BINDING_ERROR_ATTR,
  ACCOUNT_BINDING_FREE_CARD_ATTR,
  ACCOUNT_BINDING_FREE_CLAIM_ATTR,
  ACCOUNT_BINDING_FREE_HANDLE_ATTR,
  ACCOUNT_BINDING_LOADING_ATTR,
  ACCOUNT_BINDING_PANEL_STATE_ATTR,
  ACCOUNT_BINDING_PANEL_STYLES,
  ACCOUNT_BINDING_PRO_ITEM_ATTR,
  ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR,
  ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR,
  ACCOUNT_BINDING_PUBLISHING_LINK_ATTR,
  ACCOUNT_BINDING_RETRY_ATTR,
  ACCOUNT_BINDING_SESSION_ATTR,
  ACCOUNT_BINDING_SIGNOUT_ATTR,
  ACCOUNT_BINDING_SUMMARY_ATTR,
  ACCOUNT_BINDING_UNBIND_ATTR,
  ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR,
  mountAccountBindingPanel,
  type MountAccountBindingPanelOptions,
} from '../settings/account-binding-panel.js';
import type { AccountBindingAuthSession } from '../settings/account-binding-auth-client.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
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
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    removeAttribute(k) {
      el.attrs.delete(k);
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
    get firstChild() {
      return el.children[0] ?? null;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const arr = el.listeners.get(name) ?? [];
      arr.push(fn);
      el.listeners.set(name, arr);
    },
    removeEventListener(name, fn) {
      const arr = el.listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click() {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    out.push(root);
  }
  for (const child of root.children) findAllByAttr(child, attr, value, out);
  return out;
};

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => findAllByAttr(root, attr, value)[0] ?? null;

const textOf = (root: FakeElement): string =>
  `${root.textContent}${root.children.map(textOf).join('')}`;

const summary = (
  overrides: Partial<AccountBindingSummary> = {},
): AccountBindingSummary => ({
  account_id: 'acct-1',
  publisher_handle: 'mary',
  server_fingerprint: 'sha256:server',
  bound_at: 1_700_000_000_000,
  ...overrides,
});

const unbound = (): AccountBindingStatusResponse => ({
  status: 'unbound',
  binding: null,
});

const bound = (
  binding: AccountBindingSummary = summary(),
): AccountBindingStatusResponse => ({
  status: 'bound',
  binding,
});

const proItem = (
  state: ProConvenienceItemState,
  overrides: Partial<ProConvenienceItem> = {},
): ProConvenienceItem => ({
  state,
  ...overrides,
});

const proStatus = (
  overrides: Partial<ProConvenienceStatusResponse> = {},
): ProConvenienceStatusResponse => ({
  entitlement: 'entitled',
  account_id: 'acct-1',
  publisher_handle: 'mary',
  ddns_hostname: 'mary.recued.net',
  items: {
    handle: proItem('active'),
    ddns: proItem('active'),
    acme: proItem('active', { expires_at: 1_710_000_000_000 }),
  },
  ...overrides,
});

const authedSession = () => ({
  authenticated: true as const,
  user: { id: 'acct-1', email: 'mary@example.com' },
  expiresAt: 1_700_000_100_000,
  csrfToken: 'csrf',
});

const unboundProStatus = (): ProConvenienceStatusResponse => ({
  entitlement: 'unbound',
  items: {
    handle: proItem('awaiting-server', { detail: 'no_binding' }),
    ddns: proItem('awaiting-server', { detail: 'no_binding' }),
    acme: proItem('awaiting-server', { detail: 'no_binding' }),
  },
});

const mountFixture = (
  overrides: Partial<MountAccountBindingPanelOptions> = {},
) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const opts: MountAccountBindingPanelOptions = {
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runBindingStatus: vi.fn(async () => unbound()),
    runBind: vi.fn(async (): Promise<AccountBindResult> => ({
      outcome: 'bound',
      binding: summary(),
    })),
    runUnbind: vi.fn(async (): Promise<AccountUnbindResult> => ({
      outcome: 'not_bound',
    })),
    runProStatus: vi.fn(async () => unboundProStatus()),
    mintBindingToken: vi.fn(async () => ({
      binding_token: 'binding-token-1',
      expires_at: 1_700_000_060_000,
    })),
    dashboardUrl: 'https://dashboard.example/',
    ...overrides,
  };
  const mount = mountAccountBindingPanel(opts);
  return { host, mount, opts };
};

describe('D-174 account binding panel — status states', () => {
  it('renders a loading skeleton before the first reads settle', () => {
    let resolveStatus!: (value: AccountBindingStatusResponse) => void;
    const pendingStatus = new Promise<AccountBindingStatusResponse>((resolve) => {
      resolveStatus = resolve;
    });
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(() => pendingStatus),
    });

    expect(findByAttr(host, ACCOUNT_BINDING_LOADING_ATTR)).not.toBeNull();
    resolveStatus(unbound());
    mount.dispose();
  });

  it('renders not-connected from unbound status', async () => {
    const { host, mount } = mountFixture();
    await mount.whenLoaded();

    expect(mount.viewState()).toBe('not-connected');
    expect(findByAttr(host, ACCOUNT_BINDING_PANEL_STATE_ATTR)?.getAttribute(
      ACCOUNT_BINDING_PANEL_STATE_ATTR,
    )).toBe('not-connected');
    expect(textOf(host)).toContain('Not connected');
    mount.dispose();
  });

  // The session is read on an UNBOUND server only inside the user-initiated
  // connect action (never on panel open — see the session-gate describe), so
  // that press is where `connected-no-server` becomes reachable: signed in at
  // recued.com, but the bind that follows didn't land.
  it('renders connected-but-no-server when Connect finds a session the bind cannot use', async () => {
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => ({
        authenticated: true,
        user: { id: 'acct-1', email: 'mary@example.com' },
        expiresAt: 1_700_000_100_000,
        csrfToken: 'csrf',
      })),
      mintBindingToken: vi.fn(async () => {
        throw new Error('Recued could not make the link token.');
      }),
    });
    await mount.whenLoaded();
    expect(mount.viewState()).toBe('not-connected');

    await mount.connect();

    expect(mount.viewState()).toBe('connected-no-server');
    expect(textOf(host)).toContain('Signed in, but your server is not hooked up');
    mount.dispose();
  });

  it('renders bound-active with the secret-free binding summary', async () => {
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runProStatus: vi.fn(async () => proStatus()),
    });
    await mount.whenLoaded();

    const rendered = textOf(host);
    expect(mount.viewState()).toBe('bound-active');
    expect(findByAttr(host, ACCOUNT_BINDING_SUMMARY_ATTR)).not.toBeNull();
    expect(rendered).toContain('acct-1 (@mary)');
    expect(rendered).toContain('mary.recued.net');
    expect(rendered).not.toContain('server_scoped_credential');
    expect(rendered).not.toContain('binding-token');
    mount.dispose();
  });
});

describe('D-174 account binding panel — connect flow', () => {
  it('owns a Connect mutation through its authoritative refresh', async () => {
    let statusCalls = 0;
    let resolveRefresh!: (value: AccountBindingStatusResponse) => void;
    const refreshed = new Promise<AccountBindingStatusResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    const runBindingStatus = vi.fn(() => {
      statusCalls += 1;
      return statusCalls === 1 ? Promise.resolve(unbound()) : refreshed;
    });
    let resolveBind!: (value: AccountBindResult) => void;
    const runBind = vi.fn(
      () => new Promise<AccountBindResult>((resolve) => {
        resolveBind = resolve;
      }),
    );
    const { mount } = mountFixture({ runBindingStatus, runBind });
    await mount.whenLoaded();

    expect(mount.hasInFlightWork()).toBe(false);
    const pending = mount.connect();
    expect(mount.hasInFlightWork()).toBe(true);
    await Promise.resolve();
    resolveBind({ outcome: 'bound', binding: summary() });
    for (let i = 0; i < 4 && runBindingStatus.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(runBindingStatus).toHaveBeenCalledTimes(2);
    expect(mount.hasInFlightWork()).toBe(true);

    resolveRefresh(bound());
    await pending;
    expect(mount.hasInFlightWork()).toBe(false);
    mount.dispose();
  });

  it('keeps the Connect command focusable, busy, and single-flight', async () => {
    let resolveBind!: (value: AccountBindResult) => void;
    const runBind = vi.fn(
      () => new Promise<AccountBindResult>((resolve) => {
        resolveBind = resolve;
      }),
    );
    const { host, mount, opts } = mountFixture({ runBind });
    await mount.whenLoaded();

    findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)?.click();
    const pending = findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR);
    expect(pending?.textContent).toBe('Connecting…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    pending?.click();
    pending?.click();
    expect(opts.mintBindingToken).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(runBind).toHaveBeenCalledTimes(1);

    resolveBind({ outcome: 'bound', binding: summary() });
    await Promise.resolve();
    mount.dispose();
  });

  it('mints a binding token and relays it to account.bind on bound', async () => {
    let current = unbound();
    const next = bound();
    const runBind = vi.fn(async (args): Promise<AccountBindResult> => {
      expect(args).toEqual({ binding_token: 'binding-token-1' });
      current = next;
      return { outcome: 'bound', binding: next.binding! };
    });
    const { mount, opts } = mountFixture({
      runBindingStatus: vi.fn(async () => current),
      runBind,
    });
    await mount.whenLoaded();
    await mount.connect();

    expect(opts.mintBindingToken).toHaveBeenCalledTimes(1);
    expect(runBind).toHaveBeenCalledTimes(1);
    expect(mount.getState().bindingStatus?.status).toBe('bound');
    expect(mount.getState().actionMessage).toContain('Your server is hooked up');
    mount.dispose();
  });

  it('refreshes status after a rebound result', async () => {
    let current = unbound();
    const reboundBinding = summary({
      account_id: 'acct-2',
      publisher_handle: 'sara',
      rebound_at: 1_700_000_010_000,
    });
    const runBind = vi.fn(async (): Promise<AccountBindResult> => {
      current = bound(reboundBinding);
      return {
        outcome: 'rebound',
        binding: reboundBinding,
        previous_account_id: 'acct-1',
      };
    });
    const { mount } = mountFixture({
      runBindingStatus: vi.fn(async () => current),
      runBind,
    });
    await mount.whenLoaded();
    await mount.connect();

    expect(mount.getState().bindingStatus?.binding?.account_id).toBe('acct-2');
    expect(mount.getState().actionMessage).toContain('now belongs to this recued.com account');
    mount.dispose();
  });

  it('renders conflict and re-mints before confirm_rebind relay', async () => {
    let current = bound(summary({ account_id: 'acct-old', publisher_handle: 'old' }));
    const reboundBinding = summary({ account_id: 'acct-new', publisher_handle: 'new' });
    const tokens = ['binding-token-1', 'binding-token-2'];
    const runBind = vi.fn(async (args): Promise<AccountBindResult> => {
      if (args.confirm_rebind === true) {
        current = bound(reboundBinding);
        return {
          outcome: 'rebound',
          binding: reboundBinding,
          previous_account_id: 'acct-old',
        };
      }
      return {
        outcome: 'conflict',
        current_owner: current.binding!,
        incoming: { account_id: 'acct-new', publisher_handle: 'new' },
      };
    });
    const { host, mount, opts } = mountFixture({
      runBindingStatus: vi.fn(async () => current),
      runBind,
      mintBindingToken: vi.fn(async () => ({
        binding_token: tokens.shift() ?? 'missing',
        expires_at: 1_700_000_060_000,
      })),
    });
    await mount.whenLoaded();
    await mount.connect();

    expect(mount.viewState()).toBe('conflict');
    expect(mount.hasInFlightWork()).toBe(false);
    const conflictDialog = findByAttr(host, 'role', 'alertdialog');
    expect(conflictDialog).not.toBeNull();
    expect(conflictDialog?.getAttribute('aria-labelledby'))
      .toBe('account-binding-conflict-title');
    expect(findByAttr(host, ACCOUNT_BINDING_CONFIRM_REBIND_ATTR)).not.toBeNull();
    expect(textOf(host)).toContain('acct-old (@old)');
    expect(textOf(host)).toContain('acct-new (@new)');

    await mount.confirmRebind();
    expect(opts.mintBindingToken).toHaveBeenCalledTimes(2);
    expect(runBind).toHaveBeenLastCalledWith({
      binding_token: 'binding-token-2',
      confirm_rebind: true,
    });
    expect(mount.viewState()).toBe('bound-active');
    mount.dispose();
  });

  it('keeps Yes, move it focusable, busy, and single-flight', async () => {
    let resolveRebind!: (value: AccountBindResult) => void;
    const rebind = new Promise<AccountBindResult>((resolve) => {
      resolveRebind = resolve;
    });
    const runBind = vi.fn((args): Promise<AccountBindResult> => {
      if (args.confirm_rebind === true) return rebind;
      return Promise.resolve({
        outcome: 'conflict',
        current_owner: summary({ account_id: 'acct-old' }),
        incoming: { account_id: 'acct-new', publisher_handle: 'new' },
      });
    });
    const { host, mount, opts } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runBind,
    });
    await mount.whenLoaded();
    await mount.connect();

    findByAttr(host, ACCOUNT_BINDING_CONFIRM_REBIND_ATTR)?.click();
    expect(mount.hasInFlightWork()).toBe(true);
    const confirm = findByAttr(host, ACCOUNT_BINDING_CONFIRM_REBIND_ATTR);
    const cancel = findByAttr(host, ACCOUNT_BINDING_CANCEL_REBIND_ATTR);
    expect(confirm?.textContent).toBe('Rebinding…');
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
    expect(confirm?.disabled).toBe(false);
    expect(cancel?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.disabled).toBe(false);
    confirm?.click();
    cancel?.click();
    expect(opts.mintBindingToken).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(runBind).toHaveBeenCalledTimes(2);

    resolveRebind({
      outcome: 'rebound',
      binding: summary({ account_id: 'acct-new' }),
      previous_account_id: 'acct-old',
    });
    await Promise.resolve();
    mount.dispose();
  });

  it('cancels a conflict without relaying a confirm_rebind', async () => {
    const runBind = vi.fn(async (): Promise<AccountBindResult> => ({
      outcome: 'conflict',
      current_owner: summary({ account_id: 'acct-old' }),
      incoming: { account_id: 'acct-new', publisher_handle: 'new' },
    }));
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runBind,
    });
    await mount.whenLoaded();
    await mount.connect();

    mount.cancelRebind();
    expect(mount.viewState()).toBe('bound-active');
    expect(findByAttr(host, 'role', 'alertdialog')).toBeNull();
    expect(mount.getState().actionMessage).toBe('Nothing was moved.');
    expect(runBind).toHaveBeenCalledTimes(1);
    mount.dispose();
  });
});

describe('D-174 account binding panel — unbind and Pro status', () => {
  it('reviews Disconnect safely and Cancel does not call account.unbind', async () => {
    const { host, mount, opts } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
    });
    await mount.whenLoaded();

    findByAttr(host, ACCOUNT_BINDING_UNBIND_ATTR)?.click();
    const confirmation = findByAttr(
      host,
      ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR,
    );
    expect(confirmation).not.toBeNull();
    expect(confirmation?.getAttribute('role')).toBe('alertdialog');
    expect(confirmation?.getAttribute('aria-labelledby'))
      .toBe('account-binding-unbind-title');
    expect(confirmation?.getAttribute('aria-describedby'))
      .toBe('account-binding-unbind-description');
    expect(findByAttr(host, ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR)?.textContent)
      .toBe('Disconnect server');
    expect(textOf(confirmation!)).toContain('This browser stays signed in');
    expect(opts.runUnbind).not.toHaveBeenCalled();

    findByAttr(host, ACCOUNT_BINDING_CANCEL_UNBIND_ATTR)?.click();
    expect(findByAttr(host, ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR)).toBeNull();
    expect(opts.runUnbind).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('keeps Confirm Disconnect focusable, busy, and single-flight', async () => {
    let resolveUnbind!: (value: AccountUnbindResult) => void;
    const runUnbind = vi.fn(
      () => new Promise<AccountUnbindResult>((resolve) => {
        resolveUnbind = resolve;
      }),
    );
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runUnbind,
    });
    await mount.whenLoaded();
    findByAttr(host, ACCOUNT_BINDING_UNBIND_ATTR)?.click();

    findByAttr(host, ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR)?.click();
    expect(mount.hasInFlightWork()).toBe(true);
    const confirm = findByAttr(host, ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR);
    const cancel = findByAttr(host, ACCOUNT_BINDING_CANCEL_UNBIND_ATTR);
    expect(confirm?.textContent).toBe('Disconnecting…');
    expect(confirm?.getAttribute('aria-disabled')).toBe('true');
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
    expect(confirm?.disabled).toBe(false);
    expect(cancel?.getAttribute('aria-disabled')).toBe('true');
    expect(cancel?.disabled).toBe(false);
    confirm?.click();
    cancel?.click();
    expect(runUnbind).toHaveBeenCalledTimes(1);

    resolveUnbind({ outcome: 'unbound', previous: summary() });
    await Promise.resolve();
    mount.dispose();
  });

  it('calls account.unbind and handles the idempotent not_bound path', async () => {
    const { host, mount, opts } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runUnbind: vi.fn(async (): Promise<AccountUnbindResult> => ({
        outcome: 'not_bound',
      })),
    });
    await mount.whenLoaded();
    await mount.unbind();

    expect(opts.runUnbind).toHaveBeenCalledTimes(1);
    expect(mount.hasInFlightWork()).toBe(false);
    expect(findByAttr(host, ACCOUNT_BINDING_ACTION_MESSAGE_ATTR)).not.toBeNull();
    expect(textOf(host)).toContain('This server was not hooked up');
    mount.dispose();
  });

  it('renders only ddns + acme Pro items (handle is no longer Pro) with the not-entitled subscribe CTA', async () => {
    const { host, mount } = mountFixture({
      runProStatus: vi.fn(async () => proStatus({
        entitlement: 'not_entitled',
        items: {
          handle: proItem('inactive-free', { detail: 'free_account' }),
          ddns: proItem('inactive-free', { detail: 'free_account' }),
          acme: proItem('inactive-free', { detail: 'free_account' }),
        },
      })),
    });
    await mount.whenLoaded();

    // Post-R27 the Pro card carries only the DDNS web address + ACME cert; the
    // handle is lifted into the Free-account card.
    expect(findAllByAttr(host, ACCOUNT_BINDING_PRO_ITEM_ATTR)).toHaveLength(2);
    expect(findByAttr(host, ACCOUNT_BINDING_PRO_ITEM_ATTR, 'handle')).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_PRO_ITEM_ATTR, 'ddns')).not.toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_PRO_ITEM_ATTR, 'acme')).not.toBeNull();
    const cta = findByAttr(host, ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR);
    expect(cta?.getAttribute('href')).toBe('https://dashboard.example/');
    expect(cta?.className).toContain('rx-btn-secondary');
    expect(textOf(host)).toContain('Subscribe in dashboard');
    // The handle that used to be a Pro item now lives in the Free-account card.
    expect(findByAttr(host, ACCOUNT_BINDING_FREE_HANDLE_ATTR)).not.toBeNull();
    mount.dispose();
  });

  it('surfaces RPC errors inline without rejecting the route load', async () => {
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => {
        throw new Error('unknown method: account.bindingStatus');
      }),
      runProStatus: vi.fn(async () => {
        throw new Error('not_configured: pro_convenience.status');
      }),
    });
    await expect(mount.whenLoaded()).resolves.toBeUndefined();

    const errors = findAllByAttr(host, ACCOUNT_BINDING_ERROR_ATTR);
    expect(errors).toHaveLength(2);
    expect(textOf(host)).toContain('unknown method: account.bindingStatus');
    expect(textOf(host)).toContain('not_configured: pro_convenience.status');
    mount.dispose();
  });

  it('gates unknown binding state and retries all account reads in place', async () => {
    let bindingAttempt = 0;
    let proAttempt = 0;
    let resolveBinding!: (value: AccountBindingStatusResponse) => void;
    let resolvePro!: (value: ProConvenienceStatusResponse) => void;
    const runBindingStatus = vi.fn(() => {
      bindingAttempt += 1;
      if (bindingAttempt === 1) {
        return Promise.reject(new Error('binding status unavailable'));
      }
      return new Promise<AccountBindingStatusResponse>((resolve) => {
        resolveBinding = resolve;
      });
    });
    const runProStatus = vi.fn(() => {
      proAttempt += 1;
      if (proAttempt === 1) {
        return Promise.reject(new Error('plan status unavailable'));
      }
      return new Promise<ProConvenienceStatusResponse>((resolve) => {
        resolvePro = resolve;
      });
    });
    const runReadSession = vi.fn(async () => authedSession());
    const { host, mount } = mountFixture({
      runBindingStatus,
      runProStatus,
      runReadSession,
    });
    await mount.whenLoaded();

    // Two chips, not three: an UNKNOWN binding state is not a bound one, so the
    // panel must not go ask recued.com about it.
    expect(findAllByAttr(host, ACCOUNT_BINDING_ERROR_ATTR)).toHaveLength(2);
    expect(runReadSession).not.toHaveBeenCalled();
    expect(findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)).toBeNull();
    findByAttr(host, ACCOUNT_BINDING_RETRY_ATTR)?.click();
    const retry = findByAttr(host, ACCOUNT_BINDING_RETRY_ATTR);
    expect(retry?.textContent).toBe('Checking your account again…');
    expect(retry?.getAttribute('aria-disabled')).toBe('true');
    expect(retry?.getAttribute('aria-busy')).toBe('true');
    expect(retry?.disabled).toBe(false);
    expect(findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)).toBeNull();
    retry?.click();
    retry?.click();
    expect(runBindingStatus).toHaveBeenCalledTimes(2);
    expect(runProStatus).toHaveBeenCalledTimes(2);

    resolveBinding(bound());
    resolvePro(proStatus());
    await mount.whenLoaded();
    // The retry landed a KNOWN bound server — now the session read joins in.
    expect(runReadSession).toHaveBeenCalledTimes(1);
    expect(findAllByAttr(host, ACCOUNT_BINDING_ERROR_ATTR)).toHaveLength(0);
    expect(findByAttr(host, ACCOUNT_BINDING_RETRY_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)).not.toBeNull();
    mount.dispose();
  });

  it('replaces a raw recued.com fetch failure with contextual recovery copy', async () => {
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runProStatus: vi.fn(async () => proStatus()),
      runReadSession: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await mount.whenLoaded();

    expect(textOf(host)).toContain(
      'Recued could not reach recued.com. Your own server is still connected.',
    );
    expect(textOf(host)).not.toContain('Failed to fetch');
    mount.dispose();
  });
});

describe('R27 account panel — Free-account card', () => {
  it('renders the marketplace handle, Publishing Free, and a Manage-in-dashboard link', async () => {
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runProStatus: vi.fn(async () =>
        proStatus({ entitlement: 'not_entitled', publisher_handle: 'mary' })),
    });
    await mount.whenLoaded();

    const freeCard = findByAttr(host, ACCOUNT_BINDING_FREE_CARD_ATTR);
    expect(freeCard).not.toBeNull();
    expect(textOf(freeCard!)).toContain('Free account');
    expect(findByAttr(host, ACCOUNT_BINDING_FREE_HANDLE_ATTR)).not.toBeNull();
    expect(textOf(freeCard!)).toContain('@mary');
    expect(textOf(freeCard!)).toContain('Publishing');
    const manage = findByAttr(host, ACCOUNT_BINDING_PUBLISHING_LINK_ATTR);
    expect(manage?.getAttribute('href')).toBe('https://dashboard.example/');
    expect(manage?.textContent).toBe('Manage in dashboard');
    expect(manage?.className).toContain('account-bind-dashboard-inline');
    expect(ACCOUNT_BINDING_PANEL_STYLES).toContain(
      '.account-bind-dashboard-inline {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(findByAttr(host, ACCOUNT_BINDING_FREE_CLAIM_ATTR)).toBeNull();
    mount.dispose();
  });

  it('prompts to claim a handle in the dashboard when none is reserved', async () => {
    const { host, mount } = mountFixture({
      runProStatus: vi.fn(async () => unboundProStatus()),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_FREE_HANDLE_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_FREE_CLAIM_ATTR)).not.toBeNull();
    const link = findByAttr(host, ACCOUNT_BINDING_PUBLISHING_LINK_ATTR);
    expect(link?.textContent).toBe('Pick your name in the dashboard');
    expect(link?.getAttribute('href')).toBe('https://dashboard.example/');
    expect(link?.className).toContain('rx-btn-secondary');
    mount.dispose();
  });

  it('surfaces the proStatus error exactly once, on the Free card', async () => {
    const { host, mount } = mountFixture({
      runProStatus: vi.fn(async () => {
        throw new Error('not_configured: pro_convenience.status');
      }),
    });
    await mount.whenLoaded();

    expect(findAllByAttr(host, ACCOUNT_BINDING_ERROR_ATTR, 'proStatus')).toHaveLength(1);
    mount.dispose();
  });
});

// The Settings route mounts EVERY section eagerly, so this panel's mount is
// reached by opening any settings surface. Its session read is the only
// cross-origin call it makes — to the auth Worker at `auth.recued.com` — and a
// self-hosted server with no account must never make it just because its owner
// opened Settings.
describe('account panel — recued.com session gate', () => {
  it('does not read the recued.com session when the server is unbound', async () => {
    const runReadSession = vi.fn(async () => authedSession());
    const { host, mount } = mountFixture({ runReadSession });
    await mount.whenLoaded();

    expect(runReadSession).not.toHaveBeenCalled();
    // …and the panel is still usable: status renders and Connect is offered.
    expect(mount.viewState()).toBe('not-connected');
    expect(mount.getState().errors.session).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)?.textContent)
      .toBe('Connect your recued.com account');
    mount.dispose();
  });

  it('reads the recued.com session when the server holds a binding', async () => {
    const runReadSession = vi.fn(async () => authedSession());
    const { mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runProStatus: vi.fn(async () => proStatus()),
      runReadSession,
    });
    await mount.whenLoaded();

    expect(runReadSession).toHaveBeenCalledTimes(1);
    expect(mount.getState().session?.authenticated).toBe(true);
    mount.dispose();
  });

  it('reads the recued.com session on an unbound server when the owner presses Connect', async () => {
    const runReadSession = vi.fn(async () => authedSession());
    const { host, mount } = mountFixture({ runReadSession });
    await mount.whenLoaded();
    expect(runReadSession).not.toHaveBeenCalled();

    findByAttr(host, ACCOUNT_BINDING_CONNECT_ATTR)?.click();
    await mount.whenLoaded();

    expect(runReadSession).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('keeps a session already read when the server is later unbound', async () => {
    let status = bound();
    const runReadSession = vi.fn(async () => authedSession());
    const { host, mount } = mountFixture({
      runBindingStatus: vi.fn(async () => status),
      runProStatus: vi.fn(async () => proStatus()),
      runReadSession,
      runUnbind: vi.fn(async (): Promise<AccountUnbindResult> => {
        status = unbound();
        return { outcome: 'unbound', previous: summary() };
      }),
      runSignOut: vi.fn(async () => {}),
    });
    await mount.whenLoaded();
    expect(runReadSession).toHaveBeenCalledTimes(1);

    await mount.unbind();

    // Unbinding the SERVER does not sign the BROWSER out, so the last known
    // session survives the (now skipped) read — no second cloud call to learn
    // something that did not change.
    expect(runReadSession).toHaveBeenCalledTimes(1);
    expect(mount.getState().bindingStatus?.status).toBe('unbound');
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)?.textContent)
      .toContain('mary@example.com');
    mount.dispose();
  });
});

describe('R27 account panel — recued.com session sign-out', () => {
  const unauthed = (): AccountBindingAuthSession => ({
    authenticated: false,
    user: null,
    expiresAt: 0,
    csrfToken: 'csrf',
  });

  // A signed-in browser on a BOUND server — the only mount that reads the
  // recued.com session (the gate; see the session-gate describe). Mounting
  // these against an unbound server would assert the sign-out UI against a
  // session the panel deliberately never fetched, so "no Sign out button"
  // would pass for the wrong reason.
  const mountSignedInFixture = (
    overrides: Partial<MountAccountBindingPanelOptions> = {},
  ) => mountFixture({
    runBindingStatus: vi.fn(async () => bound()),
    runProStatus: vi.fn(async () => proStatus()),
    ...overrides,
  });

  it('shows "Signed in as" + a Sign out action when authenticated and a signout caller is wired', async () => {
    const { host, mount } = mountSignedInFixture({
      runReadSession: vi.fn(async () => authedSession()),
      runSignOut: vi.fn(async () => {}),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).not.toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)?.textContent)
      .toContain('mary@example.com');
    mount.dispose();
  });

  it('hides Sign out when no session is authenticated', async () => {
    const { host, mount } = mountSignedInFixture({
      runReadSession: vi.fn(async () => unauthed()),
      runSignOut: vi.fn(async () => {}),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)).toBeNull();
    mount.dispose();
  });

  it('hides Sign out when signed in but no signout caller is wired', async () => {
    const { host, mount } = mountSignedInFixture({
      runReadSession: vi.fn(async () => authedSession()),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    mount.dispose();
  });

  it('keeps Sign out focusable, busy, and single-flight', async () => {
    let resolveSignOut!: () => void;
    const runSignOut = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    const { host, mount } = mountSignedInFixture({
      runReadSession: vi.fn(async () => authedSession()),
      runSignOut,
    });
    await mount.whenLoaded();

    findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)?.click();
    expect(mount.hasInFlightWork()).toBe(true);
    const pending = findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR);
    expect(pending?.textContent).toBe('Signing out…');
    expect(pending?.getAttribute('aria-disabled')).toBe('true');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.disabled).toBe(false);
    pending?.click();
    pending?.click();
    expect(runSignOut).toHaveBeenCalledTimes(1);

    resolveSignOut();
    await Promise.resolve();
    mount.dispose();
  });

  it('signs out, reports the pairing-unchanged message, and clears the session UI', async () => {
    let session: AccountBindingAuthSession = authedSession();
    const runSignOut = vi.fn(async () => {
      session = unauthed();
    });
    const { host, mount } = mountSignedInFixture({
      runReadSession: vi.fn(async () => session),
      runSignOut,
    });
    await mount.whenLoaded();
    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).not.toBeNull();

    await mount.signOut();

    expect(runSignOut).toHaveBeenCalledTimes(1);
    expect(mount.hasInFlightWork()).toBe(false);
    expect(mount.getState().actionMessage).toContain('Signed out of recued.com');
    expect(mount.getState().actionMessage).toContain('Your server is still paired');
    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)).toBeNull();
    mount.dispose();
  });

  it('keeps the session cleared even if the post-sign-out re-read fails', async () => {
    let signedOut = false;
    const runReadSession = vi.fn(async () => {
      if (signedOut) throw new Error('network blip on re-read');
      return authedSession();
    });
    const runSignOut = vi.fn(async () => {
      signedOut = true;
    });
    const { host, mount } = mountSignedInFixture({ runReadSession, runSignOut });
    await mount.whenLoaded();
    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).not.toBeNull();

    await mount.signOut();

    expect(runSignOut).toHaveBeenCalledTimes(1);
    // The follow-up session read rejected, but the UI must NOT revert to a stale
    // authenticated state — the local clear is authoritative after success.
    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)).toBeNull();
    expect(mount.getState().session).toBeNull();
    expect(mount.getState().actionMessage).toContain('Signed out of recued.com');
    mount.dispose();
  });

  it('does not unbind the server (sign-out is not Disconnect)', async () => {
    let session: AccountBindingAuthSession = authedSession();
    const runUnbind = vi.fn(async (): Promise<AccountUnbindResult> => ({ outcome: 'not_bound' }));
    const { mount } = mountFixture({
      runBindingStatus: vi.fn(async () => bound()),
      runReadSession: vi.fn(async () => session),
      runSignOut: vi.fn(async () => {
        session = unauthed();
      }),
      runUnbind,
    });
    await mount.whenLoaded();
    await mount.signOut();

    expect(runUnbind).not.toHaveBeenCalled();
    expect(mount.getState().bindingStatus?.status).toBe('bound');
    mount.dispose();
  });
});

describe('R27 account panel — Pro lifecycle line', () => {
  const cases: Array<[ProConvenienceStatusResponse['entitlement'], string]> = [
    ['entitled', 'Pro — active'],
    ['not_entitled', 'Free account'],
    ['unbound', 'No account connected'],
    ['pending', 'Checking what you pay for'],
    ['unavailable', 'Recued cannot tell'],
  ];

  for (const [entitlement, label] of cases) {
    it(`renders the "${label}" plan line for entitlement=${entitlement}`, async () => {
      const { host, mount } = mountFixture({
        runProStatus: vi.fn(async () => proStatus({ entitlement })),
      });
      await mount.whenLoaded();

      const line = findByAttr(host, ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR);
      expect(line).not.toBeNull();
      expect(textOf(line!)).toContain(label);
      mount.dispose();
    });
  }

  it('labels the Pro CTA "Manage billing" when entitled', async () => {
    const { host, mount } = mountFixture({
      runProStatus: vi.fn(async () => proStatus({ entitlement: 'entitled' })),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR)?.textContent)
      .toBe('Manage billing in dashboard');
    mount.dispose();
  });
});
