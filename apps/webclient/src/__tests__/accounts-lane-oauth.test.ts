/** D-174 Slice 2c — Mail-lane OAuth wiring (mountAccountsLanePanel).
 *
 *  Drives the mount through a minimal fake host: open-add → pick Gmail /
 *  Microsoft → enter a name → Connect, then exercises the popup→code→
 *  enrollOAuth flow with an injected fake `oauthEnv`. The pure URL builders
 *  (Slice 2b-1) and the popup driver (2b-3) are tested separately; this pins
 *  the WIRING (sync popup open, client-config fetch, byte-matched
 *  redirect_uri, enrollOAuth args, error surfacing). */

import { describe, expect, it, vi } from 'vitest';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  buildOpenerRelayRedirectUri,
  type OAuthAppConfigSnapshot,
  type SetOAuthAppConfigArgs,
} from '@recued/contracts';
import {
  mountAccountsLanePanel,
  type AccountsFirstSyncPollScheduler,
  type AccountsOAuthEnv,
  type CalendarLaneCallers,
  type FileLaneCallers,
  type MailLaneCallers,
  type OAuthClientConfigResult,
} from '../connections/accounts-lane-panel.js';
import type { FoundationalOAuthEnv } from '../connections/foundational-oauth-popup.js';
import { createFoundationalOAuthContinuity } from '../connections/foundational-oauth-continuity.js';
import { createFoundationalOAuthReloadStore } from '../connections/foundational-oauth-reload.js';

const ORIGIN = 'https://app.recued.com';
const REDIRECT_URI = 'https://app.recued.com/oauth-callback?recued_relay=opener';
const MINTED_STATE = OAUTH_OPENER_RELAY_STATE_PREFIX + 'STATE';
const RELOAD_NOW = 1_800_000_000_000;

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
};

const reloadContinuity = (
  phase: 'before_exchange' | 'during_exchange',
  accountValues: Record<string, string> = {
    name: 'work',
    send_enabled: 'true',
  },
  providerId: 'gmail' | 'graph' = 'gmail',
) => {
  const storage = memoryStorage();
  const writer = createFoundationalOAuthReloadStore({
    storage,
    scopeId: 'profile-office',
    now: () => RELOAD_NOW,
  });
  expect(writer.write({
    lane: 'mail',
    providerId,
    slug: 'work',
    accountValues,
    clientId: providerId === 'gmail' ? 'GMAIL-CID' : 'GRAPH-CID',
    phase,
    phaseStartedAt: RELOAD_NOW,
  })).toBe(true);
  return createFoundationalOAuthContinuity({
    storage,
    scopeId: 'profile-office',
    now: () => RELOAD_NOW + 1,
  });
};

// ── minimal fake host (delegated dispatcher + field delegation) ──
const makeHost = () => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  let html = '';
  let renderCount = 0;
  const host = {
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value;
      renderCount += 1;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const l = listeners.get(type) ?? [];
      l.push(fn);
      listeners.set(type, l);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const l = listeners.get(type);
      if (!l) return;
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    querySelector: () => null,
    contains: () => true,
  };
  const fire = (type: string, ev: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
  };
  const clickAction = (data: Record<string, string>) => {
    const attrs = new Map<string, string>();
    const el = {
      dataset: data,
      textContent: '',
      closest: () => el,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      getAttribute: (key: string) => attrs.get(key) ?? null,
    };
    fire('click', { target: el, preventDefault() {} });
    return el;
  };
  const field = (key: string, value: string) => {
    const el = { dataset: { acctField: key }, value, tagName: 'INPUT', closest: () => el };
    fire('input', { target: el, type: 'input' });
  };
  const credField = (key: string, value: string) => {
    const el = { dataset: { oauthCredField: key }, value, tagName: 'INPUT', closest: () => el };
    fire('input', { target: el, type: 'input' });
  };
  return { host, clickAction, field, credField, renderCount: () => renderCount };
};

// ── fake OAuth env (capturable popup + message dispatch) ──
const makeFakeOAuthEnv = (opts: { blockPopup?: boolean; origin?: string } = {}) => {
  const origin = opts.origin ?? ORIGIN;
  let popup: { closed: boolean; location: { href: string }; close: () => void } | null = null;
  let popupOpenCount = 0;
  let msgHandler: ((ev: { origin: string; data: unknown }) => void) | null = null;
  let timeoutHandler: (() => void) | null = null;
  let pollHandler: (() => void) | null = null;
  const env: FoundationalOAuthEnv = {
    origin,
    randomState: () => 'STATE',
    onMessage: (h) => {
      msgHandler = h;
      return () => { msgHandler = null; };
    },
    setTimeout: (handler) => {
      timeoutHandler = handler;
      return () => { timeoutHandler = null; };
    },
    setInterval: (handler) => {
      pollHandler = handler;
      return () => { pollHandler = null; };
    },
  };
  const oauthEnv: AccountsOAuthEnv = {
    openPopup: () => {
      popupOpenCount += 1;
      if (opts.blockPopup) return null;
      popup = { closed: false, location: { href: '' }, close: () => { popup!.closed = true; } };
      return popup;
    },
    env,
  };
  return {
    oauthEnv,
    // The relay message is posted FROM the cloud callback host (ORIGIN), which
    // is where every foundational redirect lands — NOT the PWA's env `origin`.
    // For a same-origin PWA they coincide; for a self-served PWA they differ
    // (R26.2), and the driver trusts the callback host.
    dispatchCode: (code: string, state = MINTED_STATE) =>
      msgHandler?.({ origin: ORIGIN, data: { kind: OPENER_RELAY_MESSAGE_KIND, state, code } }),
    dispatchError: (error: string, state = MINTED_STATE) =>
      msgHandler?.({ origin: ORIGIN, data: { kind: OPENER_RELAY_MESSAGE_KIND, state, error } }),
    popupHref: () => popup?.location.href ?? '',
    popupOpenCount: () => popupOpenCount,
    popupClosed: () => popup?.closed ?? false,
    fireTimeout: () => timeoutHandler?.(),
    closeAndPoll: () => {
      if (popup !== null) popup.closed = true;
      pollHandler?.();
    },
  };
};

const CONFIGURED: OAuthClientConfigResult = {
  gmail: { client_id: 'GMAIL-CID' },
  gcal: { client_id: 'GCAL-CID' },
  graph: { client_id: 'GRAPH-CID' },
};

const makeMail = (
  enrollOAuth: MailLaneCallers['enrollOAuth'],
): MailLaneCallers => ({
  list: vi.fn(async () => ({ instances: [] })),
  enrollImap: vi.fn(async () => ({ slug: 'x', send_capable: false })),
  enrollOAuth,
  delete: vi.fn(async () => ({ ok: true as const })),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A promise whose settle is driven by the test — lets us hold the
 *  enrollOAuth code-exchange open to observe the "Finishing sign-in…" state. */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Mail-lane mount whose enrollOAuth blocks on a deferred promise (the test
 *  resolves/rejects it to step through the post-consent exchange). */
const setupDeferredEnroll = () => {
  const { host, clickAction, field } = makeHost();
  const fake = makeFakeOAuthEnv();
  const exchange = deferred<{ ok: true; account_key_prefix: string }>();
  const enrollOAuth = vi.fn(() => exchange.promise);
  const getOAuthClientConfig = vi.fn(async () => CONFIGURED);
  const mount = mountAccountsLanePanel({
    host: host as unknown as HTMLElement,
    document: {} as Document,
    mail: makeMail(enrollOAuth as unknown as MailLaneCallers['enrollOAuth']),
    getOAuthClientConfig,
    oauthEnv: fake.oauthEnv,
  });
  return { mount, clickAction, field, fake, enrollOAuth, exchange };
};

const setup = (over: {
  config?: OAuthClientConfigResult;
  blockPopup?: boolean;
  origin?: string;
  syncTimestamp?: () => number | null;
  firstSyncPoll?: AccountsFirstSyncPollScheduler;
  onGoToChat?: (source: { lane: 'mail' | 'calendar' | 'file'; providerId: string; slug: string }) => void;
  onOpenLane?: (lane: 'mail' | 'calendar' | 'file') => void;
} = {}) => {
  const { host, clickAction, field, renderCount } = makeHost();
  const fake = makeFakeOAuthEnv({
    ...(over.blockPopup ? { blockPopup: true } : {}),
    ...(over.origin !== undefined ? { origin: over.origin } : {}),
  });
  let connected: Parameters<NonNullable<MailLaneCallers['enrollOAuth']>>[0] | null = null;
  const enrollOAuth = vi.fn(
    async (args: Parameters<NonNullable<MailLaneCallers['enrollOAuth']>>[0]) => {
      connected = args;
      return ({
        ok: true as const,
        account_key_prefix: `${args.provider}.${args.account_slug}`,
      });
    },
  );
  const getOAuthClientConfig = vi.fn(async () => over.config ?? CONFIGURED);
  const mail = makeMail(enrollOAuth);
  mail.list = vi.fn(async () => ({
    instances: connected === null
      ? []
      : [{
          slug: connected.account_slug,
          adapter_type: connected.provider,
          auth_state: 'healthy' as const,
          last_synced_at: over.syncTimestamp?.() ?? null,
          send_capable: false,
          account_email: 'me@example.com',
        }],
  }));
  const mount = mountAccountsLanePanel({
    host: host as unknown as HTMLElement,
    document: {} as Document,
    mail,
    getOAuthClientConfig,
    oauthEnv: fake.oauthEnv,
    ...(over.firstSyncPoll !== undefined ? { firstSyncPoll: over.firstSyncPoll } : {}),
    ...(over.onGoToChat !== undefined ? { onGoToChat: over.onGoToChat } : {}),
    ...(over.onOpenLane !== undefined ? { onOpenLane: over.onOpenLane } : {}),
  });
  return {
    mount,
    host,
    clickAction,
    field,
    fake,
    enrollOAuth,
    getOAuthClientConfig,
    renderCount,
  };
};

const setupCalendar = (over: { config?: OAuthClientConfigResult } = {}) => {
  const { host, clickAction, field } = makeHost();
  const fake = makeFakeOAuthEnv();
  const enrollOAuth = vi.fn(
    async (_args: Parameters<NonNullable<CalendarLaneCallers['enrollOAuth']>>[0]) => ({
      slug: 'work',
    }),
  );
  const enrollBasic = vi.fn(async (_args: Record<string, unknown>) => ({ slug: 'fastmail' }));
  const getOAuthClientConfig = vi.fn(async () => over.config ?? CONFIGURED);
  const mount = mountAccountsLanePanel({
    host: host as unknown as HTMLElement,
    document: {} as Document,
    initialLane: 'calendar',
    calendar: {
      list: vi.fn(async () => ({ instances: [] })),
      delete: vi.fn(async () => ({ ok: true as const })),
      enrollOAuth,
      enrollBasic,
    },
    getOAuthClientConfig,
    oauthEnv: fake.oauthEnv,
  });
  return { mount, clickAction, field, fake, enrollOAuth, enrollBasic, getOAuthClientConfig };
};

const DELETE_LANES = [
  { lane: 'mail', slug: 'work-mail', adapterType: 'gmail', providerLabel: 'Gmail' },
  { lane: 'calendar', slug: 'work-calendar', adapterType: 'gcal', providerLabel: 'Google' },
  { lane: 'file', slug: 'work-files', adapterType: 's3', providerLabel: 'S3 bucket' },
] as const;

type DeleteLaneCase = (typeof DELETE_LANES)[number];
type DeleteCaller = (args: { slug: string }) => Promise<{ ok: true }>;

/** Foundational-lane mount with one real-looking row and mutable list output.
 *  `removeRow` lets a test model a concurrent refresh while delete is pending. */
const setupDeleteConfirm = (
  laneCase: DeleteLaneCase,
  deleteImpl: DeleteCaller = async () => ({ ok: true }),
) => {
  const { host, clickAction } = makeHost();
  let rowPresent = true;
  const row = laneCase.lane === 'mail'
    ? {
        slug: laneCase.slug,
        adapter_type: laneCase.adapterType,
        auth_state: 'healthy' as const,
        last_synced_at: 1_700_000_000_000,
        send_capable: false,
        account_email: 'owner@example.com',
      }
    : {
        slug: laneCase.slug,
        platform: laneCase.lane,
        adapter_type: laneCase.adapterType,
        caps: {},
        auth_state: 'healthy' as const,
        last_synced_at: 1_700_000_000_000,
      };
  const list = vi.fn(async () => ({ instances: rowPresent ? [row] : [] }));
  const deleteCaller = vi.fn(deleteImpl);
  const base = {
    host: host as unknown as HTMLElement,
    document: {} as Document,
    initialLane: laneCase.lane,
  };
  const mount = laneCase.lane === 'mail'
    ? mountAccountsLanePanel({
        ...base,
        mail: {
          list: list as unknown as MailLaneCallers['list'],
          enrollImap: vi.fn(async () => ({ slug: 'unused', send_capable: false })),
          delete: deleteCaller,
        },
      })
    : laneCase.lane === 'calendar'
      ? mountAccountsLanePanel({
          ...base,
          calendar: {
            list: list as unknown as CalendarLaneCallers['list'],
            delete: deleteCaller,
          },
        })
      : mountAccountsLanePanel({
          ...base,
          file: {
            list: list as unknown as FileLaneCallers['list'],
            enroll: vi.fn(async () => { throw new Error('unused'); }),
            delete: deleteCaller,
          },
        });

  return {
    mount,
    host,
    clickAction,
    list,
    deleteCaller,
    removeRow: () => { rowPresent = false; },
  };
};

const openDeleteConfirm = async (
  laneCase: DeleteLaneCase,
  setupResult: ReturnType<typeof setupDeleteConfirm>,
) => {
  await setupResult.mount.whenLoaded();
  setupResult.clickAction({ action: 'accounts-open-detail', slug: laneCase.slug });
  setupResult.clickAction({ action: 'accounts-delete', slug: laneCase.slug });
};

/** Navigate open-add → pick provider → enter a name. */
const openOAuthForm = (
  clickAction: (d: Record<string, string>) => void,
  field: (k: string, v: string) => void,
  providerId: 'gmail' | 'graph',
  name = 'work',
) => {
  clickAction({ action: 'accounts-open-add' });
  clickAction({ action: 'accounts-pick-provider', provider: providerId });
  field('name', name);
};

describe('Mail lane OAuth (mountAccountsLanePanel)', () => {
  it('Gmail happy path: popup code → enrollOAuth with byte-matched redirect_uri; returns to list', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick(); // config fetched + URL built + popup navigated + listener installed
    // The popup navigated to the Google consent URL built from the config.
    expect(fake.popupHref()).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(fake.popupHref()).toContain('client_id=GMAIL-CID');
    expect(fake.popupHref()).toContain('state=' + encodeURIComponent(MINTED_STATE));

    fake.dispatchCode('AUTH-CODE-1');
    await tick(); // runOAuthPopup resolves → enrollOAuth → refresh

    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(enrollOAuth.mock.calls[0]![0]).toEqual({
      provider: 'gmail',
      account_slug: 'work',
      code: 'AUTH-CODE-1',
      redirect_uri: REDIRECT_URI,
    });
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().formError).toBeNull();
    expect(mount.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'gmail',
    });
    expect(mount.getState().rows[0]).toMatchObject({
      slug: 'work',
      sublabel: 'me@example.com',
      lastSyncedAt: null,
    });
  });

  it('post-connect actions navigate, refresh, and dismiss without repeating sign-in', async () => {
    const onGoToChat = vi.fn();
    const onOpenLane = vi.fn();
    const { mount, host, clickAction, field, fake, enrollOAuth } = setup({
      onGoToChat,
      onOpenLane,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('AUTH-CODE');
    await tick();

    expect(host.innerHTML).toContain('data-accounts-connection-success');
    expect(host.innerHTML).toContain('Gmail connected');
    expect(host.innerHTML).toContain('me@example.com');
    expect(host.innerHTML).toContain('First sync pending');

    clickAction({ action: 'accounts-success-go-chat' });
    expect(onGoToChat).toHaveBeenCalledWith({
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
    });
    clickAction({ action: 'accounts-success-open-lane', lane: 'calendar' });
    expect(onOpenLane).toHaveBeenCalledWith('calendar');
    clickAction({ action: 'accounts-success-open-lane', lane: 'not-a-lane' });
    expect(onOpenLane).toHaveBeenCalledTimes(1);
    expect(enrollOAuth).toHaveBeenCalledTimes(1);

    clickAction({ action: 'accounts-dismiss-success' });
    expect(mount.getState().connectionSuccess).toBeNull();
    expect(host.innerHTML).not.toContain('data-accounts-connection-success');
  });

  it('background-checks a pending first sync and promotes it without a loading flash', async () => {
    let syncedAt: number | null = null;
    const scheduled: Array<() => void> = [];
    const firstSyncPoll: AccountsFirstSyncPollScheduler = {
      schedule: vi.fn((handler) => {
        scheduled.push(handler);
        return () => {};
      }),
    };
    const { mount, host, clickAction, field, fake, renderCount } = setup({
      syncTimestamp: () => syncedAt,
      firstSyncPoll,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('AUTH-CODE');
    await tick();

    expect(host.innerHTML).toContain('data-sync-state="pending"');
    expect(scheduled).toHaveLength(1);
    const pendingRenderCount = renderCount();
    scheduled.shift()!();
    await tick();
    expect(host.innerHTML).toContain('data-sync-state="pending"');
    expect(renderCount()).toBe(pendingRenderCount);
    expect(scheduled).toHaveLength(1);

    syncedAt = 1_700_000_000_000;
    scheduled.shift()!();
    // A background status read keeps the pending confirmation painted until
    // the new row arrives; it never replaces it with the foreground checker.
    expect(host.innerHTML).toContain('data-sync-state="pending"');
    expect(host.innerHTML).not.toContain('data-sync-state="checking"');
    await tick();

    expect(mount.getState().rows[0]?.lastSyncedAt).toBe(1_700_000_000_000);
    expect(host.innerHTML).toContain('data-sync-state="ready"');
    expect(host.innerHTML).toContain('Ready for Chat');
    expect(scheduled).toHaveLength(0);
  });

  it('Microsoft happy path: enrollOAuth provider=graph + Microsoft authorize endpoint', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'graph', 'office');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(fake.popupHref()).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(fake.popupHref()).toContain('client_id=GRAPH-CID');

    fake.dispatchCode('AUTH-CODE-2');
    await tick();
    expect(enrollOAuth.mock.calls[0]![0]).toMatchObject({
      provider: 'graph',
      account_slug: 'office',
      code: 'AUTH-CODE-2',
      redirect_uri: REDIRECT_URI,
    });
  });

  it('unconfigured (no app-config caller, no client_id): surfaces a re-enter error; never enrolls', async () => {
    // Legacy mount: getOAuthClientConfig present but returns no gmail client_id,
    // and no getOAuthAppConfig caller (oauthAppConfig stays null = unknown), so
    // Connect falls through to getOAuthClientConfig, which yields null → error.
    const { mount, clickAction, field, fake, enrollOAuth, getOAuthClientConfig } = setup({
      config: { gmail: null, gcal: null, graph: { client_id: 'GRAPH-CID' } },
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    expect(getOAuthClientConfig).toHaveBeenCalled();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('Re-enter the Client ID and secret');
    expect(fake.popupClosed()).toBe(true); // the popup we opened is cleaned up
    expect(mount.getState().stage).toBe('form'); // stays on the form
  });

  it('popup blocked: surfaces an error without fetching config or enrolling', async () => {
    const { mount, clickAction, field, enrollOAuth, getOAuthClientConfig } = setup({
      blockPopup: true,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    expect(getOAuthClientConfig).not.toHaveBeenCalled(); // returned before the async work
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('Popup blocked');
  });

  it('declined consent: surfaces a declined error; never enrolls', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchError('access_denied');
    await tick();

    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('declined');
  });

  // A raw provider error code names a condition, not a remedy. These pin that
  // the ones with a KNOWN single fix are translated into the setting to change —
  // and, just as importantly, that the ones without a known fix are NOT.
  it('unauthorized_client on Microsoft: names the Supported-account-types fix', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'graph', 'office');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchError('unauthorized_client');
    await tick();

    const err = mount.getState().formError ?? '';
    expect(enrollOAuth).not.toHaveBeenCalled();
    // Microsoft's `unauthorized_client` is TWO faults under one code and they
    // are indistinguishable from outside the app's home tenant, so the message
    // must name BOTH — asserting only the account-type cause would send someone
    // with a mistyped Client ID to change a correct setting.
    expect(err).toContain('Application (client) ID');
    expect(err).toContain('Secret ID');
    expect(err).toContain('Supported account types');
    expect(err).toContain('personal Microsoft');
    // …and it must not just echo the code, which is what it used to do.
    expect(err).not.toBe('unauthorized_client');
  });

  it('unauthorized_client on Google: falls through rather than inventing a fix', async () => {
    const { mount, clickAction, field, fake } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchError('unauthorized_client');
    await tick();

    // The Microsoft remedy is Microsoft-specific. Showing it to a Google user
    // would send them to a console page that has no such setting, so the
    // mapping is issuer-gated and this case keeps the raw code.
    const err = mount.getState().formError ?? '';
    expect(err).toContain('unauthorized_client');
    expect(err).not.toContain('Supported account types');
  });

  it('invalid_client: warns about the Secret ID vs Application ID mix-up', async () => {
    const { mount, clickAction, field, fake } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'graph', 'office');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchError('invalid_client');
    await tick();

    // Both are GUIDs on adjacent rows of the same Entra blade, and only one
    // works — so the message names the distinction rather than saying "wrong
    // credentials".
    const err = mount.getState().formError ?? '';
    expect(err).toContain('Application (client) ID');
    expect(err).toContain('Secret ID');
  });

  it('does not enroll when the panel is disposed mid-flight', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick(); // popup open + listener installed
    mount.dispose(); // user navigates away during consent
    expect(fake.popupClosed()).toBe(true); // private/direct mount owns teardown
    fake.dispatchCode('AUTH-CODE');
    await tick();

    expect(enrollOAuth).not.toHaveBeenCalled();
  });

  it('explicit cancellation closes consent and returns to a recoverable form', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    expect(mount.getState().oauthProgressStage).toBe('waiting_for_consent');
    clickAction({ action: 'accounts-oauth-cancel' });
    await tick();

    expect(fake.popupClosed()).toBe(true);
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().stage).toBe('form');
    expect(mount.getState().formError).toContain('No account was connected');
    expect(mount.getState().oauthFinishing).toBe(false);
  });

  it('route-away reattaches the same pending consent and consumes one success', async () => {
    const continuity = createFoundationalOAuthContinuity();
    const fake = makeFakeOAuthEnv();
    const enrollOAuth = vi.fn(async () => ({
      ok: true as const,
      account_key_prefix: 'gmail.work',
    }));
    const mail = makeMail(enrollOAuth);
    const getOAuthClientConfig = vi.fn(async () => CONFIGURED);
    const mountOnFreshHost = () => {
      const surface = makeHost();
      const mount = mountAccountsLanePanel({
        host: surface.host as unknown as HTMLElement,
        document: {} as Document,
        mail,
        getOAuthClientConfig,
        oauthEnv: fake.oauthEnv,
        oauthContinuity: continuity,
        oauthReturnHref: '#connections/mail',
      });
      return { ...surface, mount };
    };

    const first = mountOnFreshHost();
    await first.mount.whenLoaded();
    openOAuthForm(first.clickAction, first.field, 'gmail');
    // The delegated fake can inject an unknown future field. It may exist in
    // route-local form state, but the boot-scoped continuity allowlist must not
    // retain it.
    first.field('future_secret', 'DO-NOT-RETAIN');
    first.clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    const originalAuthorizeUrl = fake.popupHref();
    first.mount.dispose();
    expect(fake.popupClosed()).toBe(false); // route presentation is not the owner

    const second = mountOnFreshHost();
    await second.mount.whenLoaded();
    expect(second.mount.getState()).toMatchObject({
      stage: 'form',
      providerId: 'gmail',
      values: { name: 'work' },
      oauthFinishing: true,
      oauthProgressStage: 'waiting_for_consent',
    });
    expect(continuity.snapshot()).toMatchObject({
      status: 'pending',
      returnHref: '#connections/mail',
    });
    expect(JSON.stringify(continuity.snapshot())).not.toContain('DO-NOT-RETAIN');
    expect(fake.popupHref()).toBe(originalAuthorizeUrl);
    expect(fake.popupOpenCount()).toBe(1);
    expect(getOAuthClientConfig).toHaveBeenCalledTimes(1);

    fake.dispatchCode('ROUTE-AWAY-CODE');
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(second.mount.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'gmail',
    });
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    second.mount.dispose();

    const third = mountOnFreshHost();
    await third.mount.whenLoaded();
    expect(third.mount.getState().connectionSuccess).toBeNull();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    third.mount.dispose();
    continuity.dispose();
  });

  it('route-away retains a timeout for one guided retry on remount', async () => {
    const continuity = createFoundationalOAuthContinuity();
    const fake = makeFakeOAuthEnv();
    const enrollOAuth = vi.fn(async () => ({
      ok: true as const,
      account_key_prefix: 'gmail.work',
    }));
    const mail = makeMail(enrollOAuth);
    const mountOnFreshHost = () => {
      const surface = makeHost();
      const mount = mountAccountsLanePanel({
        host: surface.host as unknown as HTMLElement,
        document: {} as Document,
        mail,
        getOAuthClientConfig: vi.fn(async () => CONFIGURED),
        oauthEnv: fake.oauthEnv,
        oauthContinuity: continuity,
      });
      return { ...surface, mount };
    };

    const first = mountOnFreshHost();
    await first.mount.whenLoaded();
    openOAuthForm(first.clickAction, first.field, 'gmail');
    first.clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    first.mount.dispose();
    expect(fake.popupClosed()).toBe(false);

    fake.fireTimeout();
    await tick();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(continuity.snapshot()).toMatchObject({ status: 'failed' });

    const second = mountOnFreshHost();
    await second.mount.whenLoaded();
    expect(second.mount.getState().stage).toBe('form');
    expect(second.mount.getState().providerId).toBe('gmail');
    expect(second.mount.getState().formError).toContain('timed out');
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    second.mount.dispose();

    const third = mountOnFreshHost();
    await third.mount.whenLoaded();
    expect(third.mount.getState().formError).toBeNull();
    expect(third.mount.getState().stage).toBe('list');
    third.mount.dispose();
    continuity.dispose();
  });

  it('reload before exchange restores the exact safe form without a stale popup or secret', async () => {
    const continuity = reloadContinuity('before_exchange', {
      name: 'work',
      send_enabled: 'false',
    });
    const { host, clickAction } = makeHost();
    const fake = makeFakeOAuthEnv();
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: makeMail(vi.fn(async () => ({
        ok: true as const,
        account_key_prefix: 'gmail.work',
      }))),
      getOAuthClientConfig: vi.fn(async () => CONFIGURED),
      oauthEnv: fake.oauthEnv,
      oauthContinuity: continuity,
    });
    await mount.whenLoaded();

    expect(mount.getState()).toMatchObject({
      stage: 'form',
      providerId: 'gmail',
      values: { name: 'work', send_enabled: 'false' },
      oauthCredValues: { client_id: 'GMAIL-CID', client_secret: '' },
      oauthFinishing: false,
    });
    expect(mount.getState().formError).toContain('tab reloaded before you finished signing in');
    expect(fake.popupOpenCount()).toBe(0);
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    expect(host.innerHTML).toContain('start again');

    // The restored receipt was consumed; ordinary form navigation does not
    // make it replay.
    clickAction({ action: 'accounts-back-to-list' });
    expect(mount.getState().formError).toBeNull();
    mount.dispose();
    continuity.dispose();
  });

  it('reload during exchange verifies a completed account before showing success', async () => {
    const continuity = reloadContinuity('during_exchange');
    const { host } = makeHost();
    const list = vi.fn(async () => ({
      instances: [{
        slug: 'work',
        adapter_type: 'gmail',
        auth_state: 'healthy' as const,
        last_synced_at: null,
        send_capable: true,
        account_email: 'owner@example.com',
      }],
    }));
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'gmail.work',
        }))),
        list,
      },
      oauthContinuity: continuity,
    });
    await mount.whenLoaded();

    expect(list).toHaveBeenCalledTimes(2);
    expect(mount.getState().oauthReloadRecovery).toBeNull();
    expect(mount.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'gmail',
    });
    expect(host.innerHTML).toContain('Account connected');
    expect(host.innerHTML).not.toContain('Start signing in again');
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    mount.dispose();
    continuity.dispose();
  });

  it('does not let optional app-config hydration block an authoritative recovery result', async () => {
    const continuity = reloadContinuity('during_exchange');
    const appConfig = deferred<OAuthAppConfigSnapshot>();
    const { host } = makeHost();
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'gmail.work',
        }))),
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work',
            adapter_type: 'gmail',
            auth_state: 'healthy' as const,
            last_synced_at: null,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
      },
      getOAuthAppConfig: () => appConfig.promise,
      oauthContinuity: continuity,
    });

    await mount.whenLoaded();
    expect(mount.getState().connectionSuccess).toMatchObject({ slug: 'work' });
    expect(continuity.snapshot()).toEqual({ status: 'idle' });

    appConfig.resolve({
      google: { client_id: 'GMAIL-CID', has_secret: true, source: 'stored' },
      microsoft: { client_id: null, has_secret: false, source: null },
    });
    await tick();
    mount.dispose();
    continuity.dispose();
  });

  it('keeps Microsoft mail success honest when the requested calendar is not visible', async () => {
    const continuity = reloadContinuity('during_exchange', {
      name: 'work',
      send_enabled: 'false',
      calendar_enabled: 'true',
    }, 'graph');
    const { host } = makeHost();
    const calendarList = vi.fn(async () => ({ instances: [] }));
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'graph.work',
        }))),
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work',
            adapter_type: 'graph',
            auth_state: 'healthy' as const,
            last_synced_at: null,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
      },
      calendar: {
        list: calendarList,
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      oauthContinuity: continuity,
    });
    await mount.whenLoaded();
    await tick();

    expect(calendarList).toHaveBeenCalledOnce();
    expect(mount.getState().connectionSuccess).toMatchObject({
      slug: 'work',
      providerId: 'graph',
      note: expect.stringContaining('requested calendar is not visible'),
    });
    expect(host.innerHTML).toContain('You do not need to repeat mail sign-in');
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    mount.dispose();
    continuity.dispose();
  });

  it('does not hold recovered Microsoft mail behind a slow calendar check', async () => {
    const continuity = reloadContinuity('during_exchange', {
      name: 'work',
      send_enabled: 'false',
      calendar_enabled: 'true',
    }, 'graph');
    const calendar = deferred<Awaited<ReturnType<CalendarLaneCallers['list']>>>();
    const { host } = makeHost();
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'graph.work',
        }))),
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work',
            adapter_type: 'graph',
            auth_state: 'healthy' as const,
            last_synced_at: null,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
      },
      calendar: {
        list: () => calendar.promise,
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      oauthContinuity: continuity,
    });

    await mount.whenLoaded();
    expect(mount.getState().connectionSuccess).toMatchObject({
      slug: 'work',
      note: expect.stringContaining('Checking the requested calendar'),
    });
    expect(continuity.snapshot()).toEqual({ status: 'idle' });

    calendar.resolve({
      instances: [{
        slug: 'work',
        platform: 'calendar',
        adapter_type: 'graph',
        caps: {
          read: 'yes',
          list_calendars: 'yes',
          create_event: 'yes',
          update_event: 'yes',
          delete_event: 'yes',
          rsvp: 'yes',
          search: 'remote',
          watch: 'poll',
          auth: 'oauth',
          recurrence: 'server',
        },
        auth_state: 'healthy',
        last_synced_at: null,
      }],
    });
    await tick();
    expect(mount.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'graph',
    });
    expect(host.innerHTML).not.toContain('Checking the requested calendar');
    mount.dispose();
    continuity.dispose();
  });

  it('does not mistake a same-name account from another provider for OAuth success', async () => {
    const continuity = reloadContinuity('during_exchange');
    const { host } = makeHost();
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'gmail.work',
        }))),
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work',
            adapter_type: 'imap',
            auth_state: 'healthy' as const,
            last_synced_at: null,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
      },
      oauthContinuity: continuity,
    });
    await mount.whenLoaded();

    expect(mount.getState().connectionSuccess).toBeNull();
    expect(mount.getState()).toMatchObject({
      stage: 'form',
      providerId: 'gmail',
      values: { name: 'work' },
    });
    expect(mount.getState().formError).toContain('another provider');
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    mount.dispose();
    continuity.dispose();
  });

  it('reload during exchange requires repeated clean misses plus a short grace before fresh sign-in', async () => {
    const continuity = reloadContinuity('during_exchange');
    const { host, clickAction } = makeHost();
    const list = vi.fn(async () => ({ instances: [] }));
    let currentNow = RELOAD_NOW + 1;
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'gmail.work',
        }))),
        list,
      },
      getOAuthClientConfig: vi.fn(async () => CONFIGURED),
      oauthContinuity: continuity,
      now: () => currentNow,
    });
    await mount.whenLoaded();

    expect(mount.getState().oauthReloadRecovery).toMatchObject({
      status: 'check_again',
      slug: 'work',
      retryAfterSeconds: 5,
    });
    expect(host.innerHTML).toContain('Do not repeat sign-in yet');
    expect(host.innerHTML).not.toContain('Start signing in again');
    expect(continuity.snapshot()).toMatchObject({ status: 'failed' });

    clickAction({ action: 'accounts-oauth-recovery-check' });
    await mount.whenLoaded();
    expect(mount.getState().oauthReloadRecovery?.status).toBe('check_again');
    expect(host.innerHTML).toContain('wait about 5 seconds');
    expect(host.innerHTML).not.toContain('Start signing in again');

    currentNow = RELOAD_NOW + 10_000;
    clickAction({ action: 'accounts-oauth-recovery-check' });
    await mount.whenLoaded();
    expect(mount.getState().oauthReloadRecovery?.status).toBe('ready_to_retry');
    expect(host.innerHTML).toContain('Start signing in again');
    expect(continuity.snapshot()).toMatchObject({ status: 'failed' });

    clickAction({ action: 'accounts-oauth-recovery-restart' });
    expect(mount.getState()).toMatchObject({
      stage: 'form',
      providerId: 'gmail',
      values: { name: 'work', send_enabled: 'true' },
      oauthReloadRecovery: null,
    });
    expect(mount.getState().formError).toContain('Repeated checks');
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    mount.dispose();
    continuity.dispose();
  });

  it('keeps an ambiguous reload recoverable when verification is offline', async () => {
    const continuity = reloadContinuity('during_exchange');
    const { host, clickAction } = makeHost();
    const list = vi.fn(async () => { throw new Error('server offline'); });
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(vi.fn(async () => ({
          ok: true as const,
          account_key_prefix: 'gmail.work',
        }))),
        list,
      },
      oauthContinuity: continuity,
    });
    await mount.whenLoaded();

    expect(mount.getState().oauthReloadRecovery).toMatchObject({
      status: 'check_again',
      error: 'server offline',
    });
    expect(host.innerHTML).toContain('Do not repeat sign-in yet');
    expect(host.innerHTML).toContain('server offline');
    expect(host.innerHTML).toContain('Check again');
    expect(host.innerHTML).not.toContain('Start signing in again');
    expect(continuity.snapshot()).toMatchObject({ status: 'failed' });

    clickAction({ action: 'accounts-oauth-recovery-check' });
    await mount.whenLoaded();
    expect(list).toHaveBeenCalledTimes(3);
    expect(continuity.snapshot()).toMatchObject({ status: 'failed' });
    mount.dispose();
    continuity.dispose();
  });

  it('does not start a second flow while one is in flight', async () => {
    const { mount, clickAction, field, fake, getOAuthClientConfig } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    clickAction({ action: 'accounts-oauth-connect' }); // ignored — submitInFlight
    await tick();

    expect(getOAuthClientConfig).toHaveBeenCalledTimes(1);
    fake.dispatchCode('AUTH-CODE');
    await tick();
  });

  it('catches an existing account name before opening a disposable consent', async () => {
    const { host, clickAction, field } = makeHost();
    const fake = makeFakeOAuthEnv();
    const enrollOAuth = vi.fn(async () => ({
      ok: true as const,
      account_key_prefix: 'gmail.work',
    }));
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: {
        ...makeMail(enrollOAuth),
        list: vi.fn(async () => ({
          instances: [{
            slug: 'work',
            adapter_type: 'gmail',
            auth_state: 'healthy' as const,
            last_synced_at: null,
            send_capable: false,
            account_email: 'owner@example.com',
          }],
        })),
      },
      getOAuthClientConfig: vi.fn(async () => CONFIGURED),
      oauthEnv: fake.oauthEnv,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });

    expect(fake.popupOpenCount()).toBe(0);
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('already exists');
    mount.dispose();
  });

  it('seeds the app origin and renders the exact redirect URI on the OAuth form', async () => {
    const { mount, host, clickAction, field } = setup();
    await mount.whenLoaded();
    // Seeded from the same env the flow uses for the redirect_uri.
    expect(mount.getState().appOrigin).toBe(ORIGIN);
    openOAuthForm(clickAction, field, 'gmail');
    expect((host as unknown as { innerHTML: string }).innerHTML).toContain(REDIRECT_URI);
  });

  it('does not seed an empty origin (no bare relative redirect hint)', async () => {
    const { mount } = setup({ origin: '' });
    await mount.whenLoaded();
    expect(mount.getState().appOrigin).toBeUndefined();
  });

  it('self-served (cross-origin) PWA: enrollOAuth gets the cloud callback + opener_origin redirect_uri', async () => {
    // PWA served from a LAN box — its http://192.168.x.x origin is rejected as a
    // provider redirect, so R26.2 Option A routes via the cloud callback and
    // carries the PWA origin as opener_origin. The callback (cloud) is the
    // message sender; the mount trusts that host, not the PWA origin.
    const { mount, clickAction, field, fake, enrollOAuth } = setup({ origin: 'http://192.168.1.50' });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    const expectedRedirect = buildOpenerRelayRedirectUri('http://192.168.1.50');
    // The authorize URL embeds the cloud-host redirect (byte-matched on enroll).
    expect(new URL(fake.popupHref()).searchParams.get('redirect_uri')).toBe(expectedRedirect);

    fake.dispatchCode('AUTH-CODE-SS');
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(enrollOAuth.mock.calls[0]![0]).toMatchObject({
      provider: 'gmail',
      account_slug: 'work',
      code: 'AUTH-CODE-SS',
      redirect_uri: expectedRedirect,
    });
    expect(mount.getState().stage).toBe('list');
  });
});

describe('OAuth route-independent progress + immediate escape', () => {
  it('shows the finishing card during the post-consent exchange, then lands on the list', async () => {
    const { mount, clickAction, field, fake, enrollOAuth, exchange } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('CODE');
    await tick(); // runOAuthPopup resolves → oauthFinishing=true → enroll pending

    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(mount.getState().oauthFinishing).toBe(true);
    expect(mount.getState().stage).toBe('form'); // form is still the stage, under the card

    exchange.resolve({ ok: true, account_key_prefix: 'gmail.work' });
    await tick();
    expect(mount.getState().oauthFinishing).toBe(false);
    expect(mount.getState().stage).toBe('list');
  });

  it('"Keep working" returns to the list immediately while the exchange keeps running', async () => {
    const { mount, clickAction, field, fake, enrollOAuth, exchange } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('CODE');
    await tick();
    expect(mount.getState().oauthFinishing).toBe(true);

    clickAction({ action: 'accounts-oauth-dismiss' });
    expect(mount.getState().oauthFinishing).toBe(false);
    expect(mount.getState().stage).toBe('list'); // immediate, exchange still pending
    expect(enrollOAuth).toHaveBeenCalledTimes(1);

    exchange.resolve({ ok: true, account_key_prefix: 'gmail.work' });
    await tick();
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().error).toBeNull();
  });

  it('Keep working before consent stays on the list when exchange begins', async () => {
    const { mount, clickAction, field, fake, enrollOAuth, exchange } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    clickAction({ action: 'accounts-oauth-dismiss' });
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().oauthFinishing).toBe(false);

    fake.dispatchCode('CODE');
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    // The waiting -> finishing controller update must not yank the owner back
    // into the status card after they explicitly chose to keep working.
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().oauthFinishing).toBe(false);

    exchange.resolve({ ok: true, account_key_prefix: 'gmail.work' });
    await tick();
    expect(mount.getState().connectionSuccess).toEqual({
      slug: 'work',
      providerId: 'gmail',
    });
  });

  it('explains the existing consent flow if Connect is tried after Keep working', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    clickAction({ action: 'accounts-oauth-dismiss' });
    openOAuthForm(clickAction, field, 'gmail', 'second');
    clickAction({ action: 'accounts-oauth-connect' });

    expect(fake.popupOpenCount()).toBe(1);
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain(
      'Finish the Gmail sign-in already in progress',
    );
    mount.dispose();
  });

  it('dismissed then exchange fails → the error surfaces as a lane-level error on the list', async () => {
    const { mount, clickAction, field, fake, exchange } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('CODE');
    await tick();
    clickAction({ action: 'accounts-oauth-dismiss' });

    exchange.reject(new Error('token exchange failed'));
    await tick();
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().error).toContain('token exchange failed');
    expect(mount.getState().formError).toBeNull();
  });

  it('exchange fails while still waiting → back to the form with the error for retry', async () => {
    const { mount, clickAction, field, fake, exchange } = setupDeferredEnroll();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    fake.dispatchCode('CODE');
    await tick();
    expect(mount.getState().oauthFinishing).toBe(true);

    exchange.reject(new Error('token exchange failed'));
    await tick();
    expect(mount.getState().oauthFinishing).toBe(false);
    expect(mount.getState().stage).toBe('form');
    expect(mount.getState().formError).toContain('token exchange failed');
  });
});

describe('Calendar lane (mountAccountsLanePanel)', () => {
  it('Google Calendar OAuth: enrollOAuth adapter=gcal with calendar wire fields', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setupCalendar();
    await mount.whenLoaded();
    clickAction({ action: 'accounts-open-add' });
    clickAction({ action: 'accounts-pick-provider', provider: 'gcal' });
    field('name', 'work');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(fake.popupHref()).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(fake.popupHref()).toContain('client_id=GCAL-CID');
    expect(fake.popupHref()).toContain('scope=' + encodeURIComponent('https://www.googleapis.com/auth/calendar'));

    fake.dispatchCode('CAL-CODE-1');
    await tick();
    // Calendar wire fields differ from mail: adapter / oauth_code / oauth_redirect_uri.
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(enrollOAuth.mock.calls[0]![0]).toEqual({
      slug: 'work',
      adapter: 'gcal',
      oauth_code: 'CAL-CODE-1',
      oauth_redirect_uri: REDIRECT_URI,
    });
    expect(mount.getState().stage).toBe('list');
  });

  it('Microsoft Calendar OAuth: enrollOAuth adapter=graph + Microsoft endpoint', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setupCalendar();
    await mount.whenLoaded();
    clickAction({ action: 'accounts-open-add' });
    clickAction({ action: 'accounts-pick-provider', provider: 'graph' });
    field('name', 'office');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(fake.popupHref()).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(fake.popupHref()).toContain('client_id=GRAPH-CID');

    fake.dispatchCode('CAL-CODE-2');
    await tick();
    expect(enrollOAuth.mock.calls[0]![0]).toMatchObject({
      slug: 'office',
      adapter: 'graph',
      oauth_code: 'CAL-CODE-2',
      oauth_redirect_uri: REDIRECT_URI,
    });
  });

  it('CalDAV: field-form submit calls enrollBasic with the projected args', async () => {
    const { mount, clickAction, field, enrollBasic } = setupCalendar();
    await mount.whenLoaded();
    clickAction({ action: 'accounts-open-add' });
    clickAction({ action: 'accounts-pick-provider', provider: 'caldav' });
    field('name', 'fastmail');
    field('server_url', 'https://caldav.fastmail.com');
    field('username', 'me@fastmail.com');
    field('password', 'app-pw');
    field('calendar_home_url', 'https://caldav.fastmail.com/dav/calendars/me/');

    clickAction({ action: 'accounts-submit-form' });
    await tick();

    expect(enrollBasic).toHaveBeenCalledTimes(1);
    expect(enrollBasic.mock.calls[0]![0]).toEqual({
      slug: 'fastmail',
      server_url: 'https://caldav.fastmail.com',
      username: 'me@fastmail.com',
      password: 'app-pw',
      calendar_home_url: 'https://caldav.fastmail.com/dav/calendars/me/',
    });
    expect(mount.getState().stage).toBe('list');
    expect(mount.getState().connectionSuccess).toEqual({
      slug: 'fastmail',
      providerId: 'caldav',
    });
  });

  it('CalDAV: omits the optional scheduling outbox when blank', async () => {
    const { mount, clickAction, field, enrollBasic } = setupCalendar();
    await mount.whenLoaded();
    clickAction({ action: 'accounts-open-add' });
    clickAction({ action: 'accounts-pick-provider', provider: 'caldav' });
    field('name', 'fastmail');
    field('server_url', 'https://caldav.fastmail.com');
    field('username', 'me');
    field('password', 'pw');
    field('calendar_home_url', 'https://caldav.fastmail.com/dav/calendars/me/');
    clickAction({ action: 'accounts-submit-form' });
    await tick();
    expect('scheduling_outbox_url' in (enrollBasic.mock.calls[0]![0] as object)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Foundational account removal confirmation (Mail / Calendar / Files)
// ════════════════════════════════════════════════════════════════

for (const laneCase of DELETE_LANES) {
  describe(`${laneCase.lane} lane delete confirmation`, () => {
    it('guards removal until the prompt is confirmed', async () => {
      const setupResult = setupDeleteConfirm(laneCase);
      await openDeleteConfirm(laneCase, setupResult);

      expect(setupResult.deleteCaller).not.toHaveBeenCalled();
      expect(setupResult.mount.getState().deleteConfirm).toEqual({
        slug: laneCase.slug,
        providerLabel: laneCase.providerLabel,
        deleting: false,
      });
    });

    it('deletes exactly once with the right slug and reloads after confirmation', async () => {
      const setupResult = setupDeleteConfirm(laneCase);
      await openDeleteConfirm(laneCase, setupResult);
      expect(setupResult.deleteCaller).not.toHaveBeenCalled();

      setupResult.clickAction({ action: 'accounts-delete-confirm' });
      await tick();

      expect(setupResult.deleteCaller).toHaveBeenCalledTimes(1);
      expect(setupResult.deleteCaller).toHaveBeenCalledWith({ slug: laneCase.slug });
      expect(setupResult.list).toHaveBeenCalledTimes(2);
      expect(setupResult.mount.getState().stage).toBe('list');
      expect(setupResult.mount.getState().deleteConfirm).toBeNull();
    });

    it('cancels without deleting', async () => {
      const setupResult = setupDeleteConfirm(laneCase);
      await openDeleteConfirm(laneCase, setupResult);

      setupResult.clickAction({ action: 'accounts-delete-cancel' });

      expect(setupResult.mount.getState().deleteConfirm).toBeNull();
      expect(setupResult.deleteCaller).not.toHaveBeenCalled();
    });

    // ⚠ The single-rpc outcome here is guaranteed by `runRowAction`'s `rowBusy`
    // dedupe, NOT by `confirmDeleteAccount`'s `dc.deleting` early-return —
    // removing that early-return leaves this test green (verified by mutation).
    // Named for the OUTCOME it actually pins so nobody reads it as coverage of
    // the prompt-level guard; `dc.deleting` is defence-in-depth plus the source
    // of the guarded/"Removing…" button state, which the assertion below pins.
    it('fires exactly one delete rpc for a double confirm (rowBusy dedupe)', async () => {
      const pending = deferred<{ ok: true }>();
      const setupResult = setupDeleteConfirm(laneCase, () => pending.promise);
      await openDeleteConfirm(laneCase, setupResult);

      setupResult.clickAction({ action: 'accounts-delete-confirm' });
      setupResult.clickAction({ action: 'accounts-delete-confirm' });

      expect(setupResult.deleteCaller).toHaveBeenCalledTimes(1);
      expect(setupResult.mount.getState().deleteConfirm).toMatchObject({
        slug: laneCase.slug,
        deleting: true,
      });
      const busyDialog = setupResult.host.innerHTML;
      expect(busyDialog).toMatch(
        /data-action="accounts-delete-confirm"[^>]*aria-disabled="true"[^>]*aria-busy="true"/,
      );
      expect(busyDialog).toMatch(
        /data-action="accounts-delete-cancel"[^>]*aria-disabled="true"/,
      );
      expect(busyDialog).not.toMatch(
        /data-action="accounts-delete-(?:confirm|cancel)"[^>]*\sdisabled(?:\s|>)/,
      );

      pending.resolve({ ok: true });
      await tick();
      expect(setupResult.deleteCaller).toHaveBeenCalledTimes(1);
    });

    it('ignores cancel while the delete caller is in flight', async () => {
      const pending = deferred<{ ok: true }>();
      const setupResult = setupDeleteConfirm(laneCase, () => pending.promise);
      await openDeleteConfirm(laneCase, setupResult);
      setupResult.clickAction({ action: 'accounts-delete-confirm' });

      setupResult.clickAction({ action: 'accounts-delete-cancel' });

      expect(setupResult.mount.getState().deleteConfirm).toMatchObject({
        slug: laneCase.slug,
        deleting: true,
      });
      expect(setupResult.deleteCaller).toHaveBeenCalledTimes(1);

      pending.resolve({ ok: true });
      await tick();
      expect(setupResult.mount.getState().deleteConfirm).toBeNull();
    });

    it('clears a failed-delete prompt and surfaces the row error', async () => {
      const setupResult = setupDeleteConfirm(laneCase, async () => {
        throw new Error('delete failed');
      });
      await openDeleteConfirm(laneCase, setupResult);
      expect(setupResult.deleteCaller).not.toHaveBeenCalled();

      setupResult.clickAction({ action: 'accounts-delete-confirm' });
      await tick();

      expect(setupResult.deleteCaller).toHaveBeenCalledTimes(1);
      expect(setupResult.mount.getState().deleteConfirm).toBeNull();
      expect(setupResult.mount.getState().rowError[laneCase.slug]).toContain('delete failed');
      expect(setupResult.host.innerHTML).toContain('delete failed');
      expect(setupResult.host.innerHTML).not.toContain('role="dialog"');
    });

    it('renders the dialog and its confirm/cancel actions only after opening', async () => {
      const setupResult = setupDeleteConfirm(laneCase);
      await setupResult.mount.whenLoaded();
      setupResult.clickAction({ action: 'accounts-open-detail', slug: laneCase.slug });

      expect(setupResult.host.innerHTML).not.toContain('role="dialog"');
      expect(setupResult.host.innerHTML).not.toContain('data-action="accounts-delete-confirm"');
      expect(setupResult.host.innerHTML).not.toContain('data-action="accounts-delete-cancel"');

      setupResult.clickAction({ action: 'accounts-delete', slug: laneCase.slug });

      expect(setupResult.host.innerHTML).toContain('data-accounts-delete-backdrop');
      expect(setupResult.host.innerHTML).toContain(
        'data-accounts-delete-dialog tabindex="-1"',
      );
      expect(setupResult.host.innerHTML).toContain('role="dialog"');
      expect(setupResult.host.innerHTML).toContain('data-action="accounts-delete-confirm"');
      expect(setupResult.host.innerHTML).toContain('data-action="accounts-delete-cancel"');
    });

    it('keeps the resolved provider label when the row leaves during deletion', async () => {
      const pending = deferred<{ ok: true }>();
      const setupResult = setupDeleteConfirm(laneCase, () => pending.promise);
      await openDeleteConfirm(laneCase, setupResult);

      expect(setupResult.mount.getState().deleteConfirm?.providerLabel)
        .toBe(laneCase.providerLabel);
      setupResult.clickAction({ action: 'accounts-delete-confirm' });
      setupResult.removeRow();
      await setupResult.mount.refresh();

      expect(setupResult.mount.getState().rows).toEqual([]);
      expect(setupResult.mount.getState().deleteConfirm).toEqual({
        slug: laneCase.slug,
        providerLabel: laneCase.providerLabel,
        deleting: true,
      });
      expect(setupResult.host.innerHTML).toContain(`Remove ${laneCase.slug}?`);
      expect(setupResult.host.innerHTML).toContain(`this ${laneCase.providerLabel} account`);

      pending.resolve({ ok: true });
      await tick();
      expect(setupResult.mount.getState().deleteConfirm).toBeNull();
    });
  });
}

// ══════════════════════════════════════════════════════════════
// BYO OAuth-app credential setup (Google / Microsoft sign-in)
// ══════════════════════════════════════════════════════════════

const APP_CONFIG_UNSET: OAuthAppConfigSnapshot = {
  google: { client_id: null, has_secret: false, source: null },
  microsoft: { client_id: null, has_secret: false, source: null },
};
const APP_CONFIG_GOOGLE_STORED: OAuthAppConfigSnapshot = {
  google: { client_id: 'STORED-CID', has_secret: true, source: 'stored' },
  microsoft: { client_id: null, has_secret: false, source: null },
};
// A client_id WITHOUT a secret — NOT reusable: the token exchange would fail,
// so a blank-secret Connect must still demand the secret. This used to model an
// env app (`RECUED_GMAIL_CLIENT_ID` set, secret unset); those six vars were
// deleted 2026-07-28, so it now models the store's half-written row. The row is
// unreachable through the product (setIssuer writes both keys in one rolled-back
// transaction) — the guard it exercises is not, and stays worth pinning.
const APP_CONFIG_GOOGLE_ID_NO_SECRET: OAuthAppConfigSnapshot = {
  google: { client_id: 'STORED-CID', has_secret: false, source: 'stored' },
  microsoft: { client_id: null, has_secret: false, source: null },
};

/** Mail-lane mount wired with the BYO OAuth-app get/set callers. The `set`
 *  fake mutates a local snapshot so a later refetch reflects the new status
 *  (mirrors the real store-backed `getOAuthAppConfig`). */
const setupByo = (
  over: {
    appConfig?: OAuthAppConfigSnapshot;
    withSet?: boolean;
    setRejects?: boolean;
    copyText?: (value: string) => Promise<void>;
  } = {},
) => {
  const { host, clickAction, field, credField } = makeHost();
  const fake = makeFakeOAuthEnv();
  const enrollOAuth = vi.fn(
    async (_args: Parameters<NonNullable<MailLaneCallers['enrollOAuth']>>[0]) => ({
      ok: true as const,
      account_key_prefix: 'gmail.work',
    }),
  );
  const getOAuthClientConfig = vi.fn(async () => CONFIGURED);
  let current: OAuthAppConfigSnapshot = over.appConfig ?? APP_CONFIG_UNSET;
  const getOAuthAppConfig = vi.fn(async () => current);
  const setOAuthAppConfig = vi.fn(async (args: SetOAuthAppConfigArgs) => {
    if (over.setRejects) throw new Error('store write failed');
    current = {
      ...current,
      [args.issuer]: { client_id: args.client_id, has_secret: true, source: 'stored' },
    };
    return { ok: true as const };
  });
  const mount = mountAccountsLanePanel({
    host: host as unknown as HTMLElement,
    document: {} as Document,
    mail: makeMail(enrollOAuth as unknown as MailLaneCallers['enrollOAuth']),
    getOAuthClientConfig,
    getOAuthAppConfig,
    ...(over.withSet === false ? {} : { setOAuthAppConfig }),
    oauthEnv: fake.oauthEnv,
    ...(over.copyText !== undefined ? { copyText: over.copyText } : {}),
  });
  return {
    mount,
    host,
    clickAction,
    field,
    credField,
    fake,
    getOAuthAppConfig,
    setOAuthAppConfig,
    enrollOAuth,
  };
};

const hostHtml = (host: ReturnType<typeof makeHost>['host']): string =>
  (host as unknown as { innerHTML: string }).innerHTML;

describe('BYO OAuth-app credentials, inline on the connect flow', () => {
  it('fetches the OAuth-app config on the mail lane and stores it', async () => {
    const { mount, getOAuthAppConfig } = setupByo({ appConfig: APP_CONFIG_GOOGLE_STORED });
    await mount.whenLoaded();
    expect(getOAuthAppConfig).toHaveBeenCalled();
    expect(mount.getState().oauthAppConfig).toEqual(APP_CONFIG_GOOGLE_STORED);
  });

  it('keeps the lane loading until OAuth-app status settles', async () => {
    const { host } = makeHost();
    const appConfig = deferred<OAuthAppConfigSnapshot>();
    const mount = mountAccountsLanePanel({
      host: host as unknown as HTMLElement,
      document: {} as Document,
      mail: makeMail(vi.fn()),
      getOAuthAppConfig: () => appConfig.promise,
    });

    await tick(); // the immediate list resolved; app status is still pending
    expect(mount.getState().loading).toBe(true);
    expect(hostHtml(host)).not.toContain('data-action="accounts-open-add"');

    appConfig.resolve(APP_CONFIG_GOOGLE_STORED);
    await mount.whenLoaded();
    expect(mount.getState().loading).toBe(false);
    expect(hostHtml(host)).toContain('data-action="accounts-open-add"');
  });

  it('without a getOAuthAppConfig caller, config stays null (legacy path)', async () => {
    const { mount } = setup(); // original mail mount, no app-config callers
    await mount.whenLoaded();
    expect(mount.getState().oauthAppConfig).toBeNull();
  });

  it('an unconfigured OAuth form renders setup inputs without adding a route stage', async () => {
    const { mount, host, clickAction, field } = setupByo({ appConfig: APP_CONFIG_UNSET });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    const html = hostHtml(host);
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('data-oauth-cred-field="client_id"');
    expect(html).toContain('data-oauth-cred-field="client_secret"');
    expect(html).toContain('data-oauth-app-state="setup"');
    expect(html).toContain('Save setup &amp; connect Gmail');
  });

  it('copies the exact OAuth callback URI and reports completion in place', async () => {
    const copyText = vi.fn(async (_value: string) => {});
    const { mount, clickAction, field } = setupByo({ copyText });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    const copy = clickAction({
      action: 'accounts-copy-oauth-redirect',
      copyValue: REDIRECT_URI,
    });
    await tick();
    expect(copyText).toHaveBeenCalledWith(REDIRECT_URI);
    expect(copy.textContent).toBe('Copied');
    expect(copy.getAttribute('aria-live')).toBe('polite');
    expect(copy.getAttribute('aria-atomic')).toBe('true');
    expect(copy.getAttribute('aria-label')).toBe('Callback URL copied.');
  });

  it('turns clipboard failure into an actionable accessible fallback', async () => {
    const copyText = vi.fn(async (_value: string) => Promise.reject(new Error('denied')));
    const { mount, clickAction, field } = setupByo({ copyText });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    const copy = clickAction({
      action: 'accounts-copy-oauth-redirect',
      copyValue: REDIRECT_URI,
    });
    await tick();
    expect(copy.textContent).toBe('Copy manually');
    expect(copy.getAttribute('aria-label')).toContain('Copy failed');
  });

  it('opening the form pre-fills client_id from a stored app; secret stays blank', async () => {
    const { mount, clickAction, field } = setupByo({ appConfig: APP_CONFIG_GOOGLE_STORED });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    expect(mount.getState().oauthCredValues.client_id).toBe('STORED-CID');
    expect(mount.getState().oauthCredValues.client_secret).toBe('');
  });

  it('captures the inline cred fields into oauthCredValues, separate from account values', async () => {
    const { mount, clickAction, field, credField } = setupByo();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_id', 'NEW-CID');
    credField('client_secret', 'NEW-SECRET');
    expect(mount.getState().oauthCredValues).toEqual({
      client_id: 'NEW-CID',
      client_secret: 'NEW-SECRET',
    });
    // The secret never leaks into the enroll-bound account form values.
    expect(mount.getState().values['client_secret']).toBeUndefined();
  });

  it('Connect with entered creds: saves them, then runs the OAuth connect + enroll', async () => {
    const { mount, clickAction, field, credField, fake, setOAuthAppConfig, enrollOAuth } =
      setupByo();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_id', 'NEW-CID');
    credField('client_secret', 'NEW-SECRET');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick(); // save + client-config fetch + popup navigated

    expect(setOAuthAppConfig).toHaveBeenCalledTimes(1);
    expect(setOAuthAppConfig.mock.calls[0]![0]).toEqual({
      issuer: 'google',
      client_id: 'NEW-CID',
      client_secret: 'NEW-SECRET',
    });
    expect(fake.popupHref()).toContain('https://accounts.google.com/o/oauth2/v2/auth');

    fake.dispatchCode('CODE');
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(mount.getState().stage).toBe('list');
  });

  it('Connect with a configured app + blank secret: reuses it (no save), connects', async () => {
    const { mount, clickAction, field, fake, setOAuthAppConfig, enrollOAuth } = setupByo({
      appConfig: APP_CONFIG_GOOGLE_STORED,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail'); // prefills client_id, secret blank
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    // Blank secret ⇒ reuse the saved app, no write.
    expect(setOAuthAppConfig).not.toHaveBeenCalled();
    expect(fake.popupHref()).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    fake.dispatchCode('CODE');
    await tick();
    expect(enrollOAuth).toHaveBeenCalledTimes(1);
    expect(mount.getState().stage).toBe('list');
  });

  it('changing a configured Client ID requires its matching secret', async () => {
    const { mount, clickAction, field, credField, fake, setOAuthAppConfig, enrollOAuth } = setupByo({
      appConfig: APP_CONFIG_GOOGLE_STORED,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_id', 'REPLACEMENT-CID');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();

    expect(setOAuthAppConfig).not.toHaveBeenCalled();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(fake.popupHref()).toBe('');
    expect(mount.getState().formError).toContain('matching Client secret');
  });

  it('Connect with a blank secret + a known-unconfigured app: errors, no popup/enroll', async () => {
    const { mount, clickAction, field, fake, setOAuthAppConfig, enrollOAuth } = setupByo({
      appConfig: APP_CONFIG_UNSET,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail'); // unconfigured ⇒ both blank
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(setOAuthAppConfig).not.toHaveBeenCalled();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain("Client ID and secret");
    expect(mount.getState().stage).toBe('form');
    expect(fake.popupHref()).toBe(''); // popup never opened
  });

  it('blank secret + a stored app WITHOUT a secret: errors (not reusable), no popup/enroll', async () => {
    const { mount, clickAction, field, fake, setOAuthAppConfig, enrollOAuth } = setupByo({
      appConfig: APP_CONFIG_GOOGLE_ID_NO_SECRET,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail'); // client_id prefilled, secret blank
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(setOAuthAppConfig).not.toHaveBeenCalled();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('Client secret to finish');
    expect(mount.getState().stage).toBe('form');
    expect(fake.popupHref()).toBe(''); // popup never opened
  });

  it('leaving the OAuth form clears the typed client secret from mount state', async () => {
    const { mount, clickAction, field, credField } = setupByo();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_secret', 'TYPED-SECRET');
    expect(mount.getState().oauthCredValues.client_secret).toBe('TYPED-SECRET');
    clickAction({ action: 'accounts-back-to-list' });
    expect(mount.getState().oauthCredValues).toEqual({ client_id: '', client_secret: '' });
  });

  it('Connect with a secret but no Client ID: errors, never saves', async () => {
    const { mount, clickAction, field, credField, setOAuthAppConfig } = setupByo();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_secret', 'SECRET-ONLY');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(setOAuthAppConfig).not.toHaveBeenCalled();
    expect(mount.getState().formError).toContain('Client ID');
    expect(mount.getState().stage).toBe('form');
  });

  it('save failure during Connect: surfaces the error on the form, no enroll', async () => {
    const { mount, clickAction, field, credField, enrollOAuth } = setupByo({ setRejects: true });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_id', 'CID');
    credField('client_secret', 'SECRET');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick();
    expect(enrollOAuth).not.toHaveBeenCalled();
    expect(mount.getState().stage).toBe('form');
    expect(mount.getState().formError).toContain('store write failed');
  });

  it('the OAuth progress card shows from popup-open, before any code', async () => {
    const { mount, clickAction, field } = setupByo({ appConfig: APP_CONFIG_GOOGLE_STORED });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    clickAction({ action: 'accounts-oauth-connect' });
    // Set synchronously in driveOAuth at popup-open — no await needed.
    expect(mount.getState().oauthFinishing).toBe(true);
  });

  it('after save, a declined consent returns to the form with the app now shown configured', async () => {
    const { mount, clickAction, field, credField, fake } = setupByo();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    credField('client_id', 'NEW-CID');
    credField('client_secret', 'NEW-SECRET');
    clickAction({ action: 'accounts-oauth-connect' });
    await tick(); // save done + popup navigated
    fake.dispatchError('access_denied');
    await tick();
    expect(mount.getState().stage).toBe('form');
    expect(mount.getState().formError).toContain('declined');
    // The save persisted → snapshot reflects configured + the secret cleared.
    expect(mount.getState().oauthAppConfig?.google.source).toBe('stored');
    expect(mount.getState().oauthCredValues.client_secret).toBe('');
    expect(mount.getState().oauthCredValues.client_id).toBe('NEW-CID');
  });

  it('configured issuer: the form keeps Connect and collapses app credentials', async () => {
    const { mount, host, clickAction, field } = setupByo({ appConfig: APP_CONFIG_GOOGLE_STORED });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');
    const html = hostHtml(host);
    expect(html).toContain('data-action="accounts-oauth-connect"');
    expect(html).toContain('value="STORED-CID"');
    expect(html).toContain('Google sign-in is ready');
    expect(html).toContain('<details class="accounts-oauth-manage">');
  });
});
