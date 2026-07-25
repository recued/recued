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
  type MailLaneCallers,
  type OAuthClientConfigResult,
} from '../connections/accounts-lane-panel.js';
import type { FoundationalOAuthEnv } from '../connections/foundational-oauth-popup.js';

const ORIGIN = 'https://app.recued.com';
const REDIRECT_URI = 'https://app.recued.com/oauth-callback?recued_relay=opener';
const MINTED_STATE = OAUTH_OPENER_RELAY_STATE_PREFIX + 'STATE';

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
  let msgHandler: ((ev: { origin: string; data: unknown }) => void) | null = null;
  const env: FoundationalOAuthEnv = {
    origin,
    randomState: () => 'STATE',
    onMessage: (h) => {
      msgHandler = h;
      return () => { msgHandler = null; };
    },
    setTimeout: () => () => {}, // no auto-timeout in tests
    setInterval: () => () => {}, // no auto-poll in tests
  };
  const oauthEnv: AccountsOAuthEnv = {
    openPopup: () => {
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
    popupClosed: () => popup?.closed ?? false,
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

  it('does not enroll when the panel is disposed mid-flight', async () => {
    const { mount, clickAction, field, fake, enrollOAuth } = setup();
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail');

    clickAction({ action: 'accounts-oauth-connect' });
    await tick(); // popup open + listener installed
    mount.dispose(); // user navigates away during consent
    fake.dispatchCode('AUTH-CODE');
    await tick();

    expect(enrollOAuth).not.toHaveBeenCalled();
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

describe('OAuth "Finishing sign-in…" state + immediate escape', () => {
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

  it('"Back to accounts" returns to the list immediately while the exchange keeps running', async () => {
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
// BYO OAuth-app credential setup (Google / Microsoft sign-in)
// ════════════════════════════════════════════════════════════════

const APP_CONFIG_UNSET: OAuthAppConfigSnapshot = {
  google: { client_id: null, has_secret: false, source: null },
  microsoft: { client_id: null, has_secret: false, source: null },
};
const APP_CONFIG_GOOGLE_STORED: OAuthAppConfigSnapshot = {
  google: { client_id: 'STORED-CID', has_secret: true, source: 'stored' },
  microsoft: { client_id: null, has_secret: false, source: null },
};
// Env client_id WITHOUT a secret (`RECUED_GMAIL_CLIENT_ID` set, secret unset) —
// NOT reusable: the token exchange would fail, so a blank-secret Connect must
// still demand the secret.
const APP_CONFIG_GOOGLE_ENV_NO_SECRET: OAuthAppConfigSnapshot = {
  google: { client_id: 'ENV-CID', has_secret: false, source: 'env' },
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

  it('blank secret + an env app WITHOUT a secret: errors (not reusable), no popup/enroll', async () => {
    const { mount, clickAction, field, fake, setOAuthAppConfig, enrollOAuth } = setupByo({
      appConfig: APP_CONFIG_GOOGLE_ENV_NO_SECRET,
    });
    await mount.whenLoaded();
    openOAuthForm(clickAction, field, 'gmail'); // client_id prefilled from env, secret blank
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

  it('the "Signing in…" overlay shows from popup-open (oauthFinishing true before any code)', async () => {
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
