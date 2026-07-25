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
  ACCOUNT_BINDING_CONFIRM_REBIND_ATTR,
  ACCOUNT_BINDING_ERROR_ATTR,
  ACCOUNT_BINDING_FREE_CARD_ATTR,
  ACCOUNT_BINDING_FREE_CLAIM_ATTR,
  ACCOUNT_BINDING_FREE_HANDLE_ATTR,
  ACCOUNT_BINDING_LOADING_ATTR,
  ACCOUNT_BINDING_PANEL_STATE_ATTR,
  ACCOUNT_BINDING_PRO_ITEM_ATTR,
  ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR,
  ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR,
  ACCOUNT_BINDING_PUBLISHING_LINK_ATTR,
  ACCOUNT_BINDING_SESSION_ATTR,
  ACCOUNT_BINDING_SIGNOUT_ATTR,
  ACCOUNT_BINDING_SUMMARY_ATTR,
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

  it('renders connected-but-no-server when an auth session exists but the server is unbound', async () => {
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => ({
        authenticated: true,
        user: { id: 'acct-1', email: 'mary@example.com' },
        expiresAt: 1_700_000_100_000,
        csrfToken: 'csrf',
      })),
    });
    await mount.whenLoaded();

    expect(mount.viewState()).toBe('connected-no-server');
    expect(textOf(host)).toContain('Connected, server not bound');
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
    expect(mount.getState().actionMessage).toContain('Server bound');
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
    expect(mount.getState().actionMessage).toContain('rebound');
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
});

describe('D-174 account binding panel — unbind and Pro status', () => {
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
    expect(findByAttr(host, ACCOUNT_BINDING_ACTION_MESSAGE_ATTR)).not.toBeNull();
    expect(textOf(host)).toContain('No binding was stored');
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

  it('replaces a raw recued.com fetch failure with contextual recovery copy', async () => {
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await mount.whenLoaded();

    expect(textOf(host)).toContain(
      'Couldn’t reach recued.com. Your local Recued server is still connected.',
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
    expect(link?.textContent).toBe('Claim your handle in the dashboard');
    expect(link?.getAttribute('href')).toBe('https://dashboard.example/');
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

describe('R27 account panel — recued.com session sign-out', () => {
  const unauthed = (): AccountBindingAuthSession => ({
    authenticated: false,
    user: null,
    expiresAt: 0,
    csrfToken: 'csrf',
  });

  it('shows "Signed in as" + a Sign out action when authenticated and a signout caller is wired', async () => {
    const { host, mount } = mountFixture({
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
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => unauthed()),
      runSignOut: vi.fn(async () => {}),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    expect(findByAttr(host, ACCOUNT_BINDING_SESSION_ATTR)).toBeNull();
    mount.dispose();
  });

  it('hides Sign out when signed in but no signout caller is wired', async () => {
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => authedSession()),
    });
    await mount.whenLoaded();

    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).toBeNull();
    mount.dispose();
  });

  it('signs out, reports the pairing-unchanged message, and clears the session UI', async () => {
    let session: AccountBindingAuthSession = authedSession();
    const runSignOut = vi.fn(async () => {
      session = unauthed();
    });
    const { host, mount } = mountFixture({
      runReadSession: vi.fn(async () => session),
      runSignOut,
    });
    await mount.whenLoaded();
    expect(findByAttr(host, ACCOUNT_BINDING_SIGNOUT_ATTR)).not.toBeNull();

    await mount.signOut();

    expect(runSignOut).toHaveBeenCalledTimes(1);
    expect(mount.getState().actionMessage).toContain('Signed out of recued.com');
    expect(mount.getState().actionMessage).toContain('pairing is unchanged');
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
    const { host, mount } = mountFixture({ runReadSession, runSignOut });
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
    ['pending', 'Checking subscription'],
    ['unavailable', 'Status unavailable'],
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
