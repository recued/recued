/** D-347 follow-up 19 — Keep signed in (`keep-signed-in.ts`): the owner's list as kept, its windows, and what
 *  one tick of its timer does, over injected `chrome.*`. The two functions it runs in a page are driven in
 *  real Chrome (`backend/server/src/__tests__/bridge-keep-signed-in-browser.test.ts`). */

import { describe, expect, it, vi } from 'vitest';
import {
  KEEP_SIGNED_IN_ALARM,
  KEEP_SIGNED_IN_KEY,
  KEEP_SIGNED_IN_MAX_SITES,
  KEEP_SIGNED_IN_MEMORY_KEY,
  KEEP_SIGNED_IN_STATUS_KEY,
  KEEP_SIGNED_IN_WEB_STORE_SAID,
  isOnChromeWebStore,
  isSignInPage,
  keepSessionAlive,
  keepSignedInWindowOpen,
  lastedSaid,
  pageHasUnsentInput,
  readKeepSignedIn,
  runKeepSignedInTick,
  wireKeepSignedIn,
  type KeepSignedInChrome,
  type KeepSignedInDeps,
  type KeepSignedInMemory,
  type KeepSignedInSite,
  type KeepSignedInTab,
} from '../keep-signed-in.js';
import { BLOCKED_SITES_KEY, isOnBlockedSite } from '../permissions/site-grants.js';

// Monday 2026-11-09, 10:00 in this computer's time.
const MONDAY_10 = new Date(2026, 10, 9, 10, 0).getTime();
const MINUTE = 60_000;

describe('Keep signed in — the list as kept', () => {
  it('keeps the sites it can read, each once, and drops what it cannot', () => {
    const sites = readKeepSignedIn([
      { site: 'https://Console.Example.com/home', every_minutes: 10, mode: 'session' },
      { site: 'console.example.com', every_minutes: 5, mode: 'reload' },
      { site: 'mail.example.com', every_minutes: 0, mode: 'session' },
      { site: 'mail.example.com', every_minutes: 61, mode: 'session' },
      { site: 'bank.example.com', every_minutes: 10, mode: 'visit' },
      { site: 'crm.example.com', every_minutes: 15, mode: 'reload', window: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } },
      { site: 'erp.example.com', every_minutes: 15, mode: 'session', window: { days: [1], from: '18:00', to: '08:00' } },
      { site: 'ops.example.com', every_minutes: 30, mode: 'session', window: { until: MONDAY_10 }, off: true },
      'not a site',
    ]);
    expect(sites).toEqual([
      { site: 'console.example.com', every_minutes: 10, mode: 'session' },
      { site: 'crm.example.com', every_minutes: 15, mode: 'reload', window: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } },
      { site: 'ops.example.com', every_minutes: 30, mode: 'session', window: { until: MONDAY_10 }, off: true },
    ]);
    expect(readKeepSignedIn(undefined)).toEqual([]);
    const many = Array.from({ length: 25 }, (_, i) => ({ site: `s${String(i)}.example.com`, every_minutes: 10, mode: 'session' }));
    expect(readKeepSignedIn(many)).toHaveLength(KEEP_SIGNED_IN_MAX_SITES);
  });

  it('a window is open on its days between its hours, the end not included; or until its moment', () => {
    const weekdays = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
    expect(keepSignedInWindowOpen(undefined, new Date(MONDAY_10))).toBe(true);
    expect(keepSignedInWindowOpen(weekdays, new Date(MONDAY_10))).toBe(true);
    expect(keepSignedInWindowOpen(weekdays, new Date(2026, 10, 9, 7, 59))).toBe(false);
    expect(keepSignedInWindowOpen(weekdays, new Date(2026, 10, 9, 18, 0))).toBe(false);
    // Sunday.
    expect(keepSignedInWindowOpen(weekdays, new Date(2026, 10, 8, 10, 0))).toBe(false);
    expect(keepSignedInWindowOpen({ until: MONDAY_10 + MINUTE }, new Date(MONDAY_10))).toBe(true);
    expect(keepSignedInWindowOpen({ until: MONDAY_10 }, new Date(MONDAY_10))).toBe(false);
  });

  it('follow-up 23 — a Chrome Web Store page is one on either of its hosts or their subdomains, as Chromium matches it', () => {
    for (const url of ['https://chrome.google.com/u/1/webstore/devconsole/abc/items', 'https://chrome.google.com/',
      'https://CHROMEWEBSTORE.google.com/detail/x', 'https://chromewebstore.google.com./', 'http://a.chrome.google.com/x']) {
      expect([url, isOnChromeWebStore(url)]).toEqual([url, true]);
    }
    for (const url of ['https://google.com/', 'https://mail.google.com/mail/u/1/', 'https://notchrome.google.com/',
      'https://chrome.google.com.example.net/', 'https://developer.chrome.com/docs/webstore', 'not an address']) {
      expect([url, isOnChromeWebStore(url)]).toEqual([url, false]);
    }
  });
});

/** A browser the test holds: what is kept, the tabs, the window the owner is in, what a page answers, and
 *  whether a command runs. As Chrome does, it refuses a script in a Chrome Web Store page, and in the pages of
 *  `refusedIn` (a site the Bridge is not allowed on, say). A site's tabs are those on it or its subdomains, and
 *  those whose address Chrome did not give; a tab is found by its id wherever it is, and a closed one, taken out
 *  of `tabs`, is not. Its clock is `clock.at`, which a test moves on. A request from a page is answered on its site
 *  (`{ status: 200 }`) unless `answers`, which a test may change, holds another answer for its tab (follow-up 28). */
const browser = (sites: KeepSignedInSite[], tabs: KeepSignedInTab[], extra: {
  statuses?: Record<string, unknown>; front?: number | null; typedIn?: number[]; refusedIn?: number[];
  activity?: { running: number; last_ended_at: number }; now?: number; blocked?: unknown; answers?: Record<number, unknown>;
} = {}) => {
  const kept: Record<string, unknown> = { [KEEP_SIGNED_IN_KEY]: sites, ...(extra.statuses ? { [KEEP_SIGNED_IN_STATUS_KEY]: extra.statuses } : {}),
    ...(extra.blocked !== undefined ? { [BLOCKED_SITES_KEY]: extra.blocked } : {}) };
  const session: Record<string, unknown> = {};
  const ran: Array<[number, string]> = [];
  const reloaded: number[] = [];
  const updated: Array<[number, boolean]> = [];
  const clock = { at: extra.now ?? MONDAY_10 };
  const find = (tabId: number): KeepSignedInTab => {
    const tab = tabs.find((one) => one.id === tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
    return tab;
  };
  const deps: KeepSignedInDeps = {
    storage: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in kept).map((key) => [key, kept[key]])),
      set: async (items) => { Object.assign(kept, items); },
    },
    memory: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in session).map((key) => [key, session[key]])),
      set: async (items) => { Object.assign(session, structuredClone(items)); },
    },
    tabs: {
      query: async ({ url }) => {
        const site = /^\*:\/\/(.+)\/\*$/.exec(url[0]!)![1]!;
        return tabs.filter((tab) => tab.url === undefined || isOnBlockedSite(tab.url, [site]));
      },
      reload: async (tabId) => { reloaded.push(tabId); },
      get: async (tabId) => ({ ...find(tabId) }),
      update: async (tabId, props) => {
        find(tabId).autoDiscardable = props.autoDiscardable;
        updated.push([tabId, props.autoDiscardable]);
      },
    },
    focusedWindow: async () => (extra.front === undefined ? 1 : extra.front),
    runInTab: async (tabId, func) => {
      ran.push([tabId, func.name]);
      const url = tabs.find((tab) => tab.id === tabId)?.url;
      if (url !== undefined && isOnChromeWebStore(url)) throw new Error('The extensions gallery cannot be scripted.');
      if ((extra.refusedIn ?? []).includes(tabId)) throw new Error('Cannot access contents of the page.');
      if (func === keepSessionAlive) return extra.answers?.[tabId] ?? { status: 200 };
      if (func === pageHasUnsentInput) return (extra.typedIn ?? []).includes(tabId);
      throw new Error('unexpected function');
    },
    activity: () => extra.activity ?? { running: 0, last_ended_at: 0 },
    now: () => clock.at,
  };
  const status = (site: string) => (kept[KEEP_SIGNED_IN_STATUS_KEY] as Record<string, Record<string, unknown>> | undefined)?.[site];
  const memory = () => session[KEEP_SIGNED_IN_MEMORY_KEY] as KeepSignedInMemory | undefined;
  return { deps, kept, session, ran, reloaded, updated, clock, status, memory };
};
const CONSOLE: KeepSignedInSite = { site: 'console.example.com', every_minutes: 10, mode: 'session' };
/** A tick at each moment from `from` to `until`, `step` apart, as the timer comes while nothing else happens. */
const ticks = async (t: ReturnType<typeof browser>, from: number, until: number, step = 10 * MINUTE): Promise<void> => {
  for (let at = from; at <= until; at += step) {
    t.clock.at = at;
    await runKeepSignedInTick(t.deps);
  }
};
/** What a test of `t` sees written to `chrome.storage.local` from now on. */
const writesOf = (t: ReturnType<typeof browser>): unknown[] => {
  const writes: unknown[] = [];
  const set = t.deps.storage.set;
  t.deps.storage.set = async (items) => { writes.push(items); await set(items); };
  return writes;
};

describe('Keep signed in — a tick of its timer', () => {
  it('keeps the session from a tab\'s page, and is next due after its interval', async () => {
    const t = browser([CONSOLE], [{ id: 7, windowId: 1, active: true }]);
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toEqual([[7, 'keepSessionAlive']]);
    expect(t.reloaded).toEqual([]);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'kept', said: 'Kept the session.' } });
    // Not due again before then, and nothing is written: the side panel draws its section again on a write.
    const again = browser([CONSOLE], [{ id: 7 }], { statuses: { 'console.example.com': { next_at: MONDAY_10 + MINUTE } } });
    const writes: unknown[] = [];
    const set = again.deps.storage.set;
    again.deps.storage.set = async (items) => { writes.push(items); await set(items); };
    await runKeepSignedInTick(again.deps);
    expect(again.ran).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('waits while a Bridge command runs; a page is not reloaded for a minute after one either', async () => {
    const running = browser([CONSOLE], [{ id: 7 }], { activity: { running: 1, last_ended_at: 0 } });
    await runKeepSignedInTick(running.deps);
    expect(running.ran).toEqual([]);
    expect(running.status('console.example.com')).toEqual({ last: { at: MONDAY_10, what: 'skipped', said: 'Recued was acting in the browser.' } });
    // A command that ended 30 s ago: the session is kept, the page is not reloaded.
    const lately = { running: 0, last_ended_at: MONDAY_10 - 30_000 };
    const session = browser([CONSOLE], [{ id: 7 }], { activity: lately });
    await runKeepSignedInTick(session.deps);
    expect(session.ran).toEqual([[7, 'keepSessionAlive']]);
    const reload = browser([{ ...CONSOLE, mode: 'reload' }], [{ id: 7 }], { activity: lately });
    await runKeepSignedInTick(reload.deps);
    expect(reload.reloaded).toEqual([]);
    expect(reload.status('console.example.com')).toMatchObject({ last: { what: 'skipped', said: 'Recued was acting in the browser.' } });
  });

  it('reloads every tab of it but the one you are looking at and one holding something typed', async () => {
    const t = browser([{ ...CONSOLE, mode: 'reload' }], [
      { id: 7, windowId: 1, active: true }, { id: 8, windowId: 1, active: false }, { id: 9, windowId: 2, active: true },
      { id: 10, windowId: 2, active: false, discarded: true },
    ], { front: 1, typedIn: [8] });
    await runKeepSignedInTick(t.deps);
    expect(t.reloaded).toEqual([9, 10]);
    // A sleeping tab runs no script: it holds nothing typed.
    expect(t.ran).toEqual([[8, 'pageHasUnsentInput'], [9, 'pageHasUnsentInput']]);
    expect(t.status('console.example.com')).toMatchObject({ next_at: MONDAY_10 + 10 * MINUTE, last: { what: 'kept',
      said: 'Reloaded 2 tabs, leaving the one you were using and one holding something typed and not sent.' } });
    // With Chrome not in front, the tab shown in a window is no one's.
    const away = browser([{ ...CONSOLE, mode: 'reload' }], [{ id: 7, windowId: 1, active: true }], { front: null });
    await runKeepSignedInTick(away.deps);
    expect(away.reloaded).toEqual([7]);
    // All left alone: tried again at the next tick.
    const busy = browser([{ ...CONSOLE, mode: 'reload' }], [{ id: 7, windowId: 1, active: true }], { front: 1 });
    await runKeepSignedInTick(busy.deps);
    expect(busy.status('console.example.com')).toEqual({ last: { at: MONDAY_10, what: 'skipped', said: 'Left alone: the one you were using.' } });
  });

  it('with no tab showing it, or only sleeping ones, says so', async () => {
    const none = browser([CONSOLE], []);
    await runKeepSignedInTick(none.deps);
    expect(none.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'skipped', said: 'No tab shows it.' } });
    const asleep = browser([CONSOLE], [{ id: 7, discarded: true }]);
    await runKeepSignedInTick(asleep.deps);
    expect(asleep.ran).toEqual([]);
    expect(asleep.status('console.example.com')).toMatchObject({ last: { what: 'skipped',
      said: 'Chrome put its tabs to sleep, so nothing could be sent. Reloading the page keeps one awake.' } });
  });

  it('leaves a tab on a site never to use alone, and every tab while that list cannot be read', async () => {
    // The site kept, one of its subdomains never to be used: the other tab keeps the session.
    const sub = browser([CONSOLE], [{ id: 7, url: 'https://eu.console.example.com/home' }, { id: 8, url: 'https://console.example.com/' }],
      { blocked: ['eu.console.example.com'] });
    await runKeepSignedInTick(sub.deps);
    expect(sub.ran).toEqual([[8, 'keepSessionAlive']]);
    // Follow-up 27 — nor kept awake.
    expect(sub.updated).toEqual([[8, false]]);
    // The site itself, by a site above it: left alone, and said; a reload too, and a tab whose address Chrome
    // did not give is the kept site's.
    const listed = browser([CONSOLE], [{ id: 7, url: 'https://console.example.com/' }], { blocked: ['example.com'] });
    await runKeepSignedInTick(listed.deps);
    expect(listed.ran).toEqual([]);
    expect(listed.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'skipped', said: 'Left alone: it is on your list of sites never to use.' } });
    const reload = browser([{ ...CONSOLE, mode: 'reload' }], [{ id: 7 }], { blocked: ['console.example.com'] });
    await runKeepSignedInTick(reload.deps);
    expect([reload.ran, reload.reloaded]).toEqual([[], []]);
    const unreadable = browser([CONSOLE], [{ id: 7, url: 'https://console.example.com/' }], { blocked: 'not a list' });
    await runKeepSignedInTick(unreadable.deps);
    expect(unreadable.ran).toEqual([]);
    expect(unreadable.updated).toEqual([]);
    expect(unreadable.status('console.example.com')).toMatchObject({ last: { what: 'skipped',
      said: 'The list of sites never to use could not be read, so nothing was done.' } });
  });

  it('follow-up 23 — leaves a Chrome Web Store tab alone either way, says why when it is all there is, and is next due after its interval', async () => {
    // The owner's case: the store's developer console, kept by its session, then by reloads, in a tab they were not using.
    const STORE: KeepSignedInSite = { site: 'chrome.google.com', every_minutes: 10, mode: 'session' };
    const devconsole = { id: 7, windowId: 1, active: false, url: 'https://chrome.google.com/u/1/webstore/devconsole/abc/items' };
    const leftAlone = { next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'skipped', said: `Left alone: ${KEEP_SIGNED_IN_WEB_STORE_SAID}` } };
    for (const mode of ['session', 'reload'] as const) {
      const t = browser([{ ...STORE, mode }], [devconsole], { front: 1 });
      await runKeepSignedInTick(t.deps);
      expect([mode, t.ran, t.reloaded]).toEqual([mode, [], []]);
      expect(t.status('chrome.google.com')).toEqual(leftAlone);
    }
    // A tab whose address Chrome did not give is the listed site's.
    const unnamed = browser([{ ...STORE, mode: 'reload' }], [{ id: 7 }], { front: null });
    await runKeepSignedInTick(unnamed.deps);
    expect([unnamed.ran, unnamed.reloaded]).toEqual([[], []]);
    // Under a site listed above it, the store's tab is left alone and the others are refreshed.
    const tabs = [devconsole, { id: 8, windowId: 1, active: false, url: 'https://mail.google.com/mail/u/1/' }];
    const session = browser([{ ...STORE, site: 'google.com' }], tabs, { front: 1 });
    await runKeepSignedInTick(session.deps);
    expect(session.ran).toEqual([[8, 'keepSessionAlive']]);
    const reload = browser([{ ...STORE, site: 'google.com', mode: 'reload' }], tabs, { front: 1 });
    await runKeepSignedInTick(reload.deps);
    expect([reload.ran, reload.reloaded]).toEqual([[[8, 'pageHasUnsentInput']], [8]]);
    expect(reload.status('google.com')).toMatchObject({ last: { what: 'kept', said: 'Reloaded its tab.' } });
  });

  it('follow-up 24 — keeps the session in each tab of a site open in several accounts, once per address', async () => {
    // As Gmail is, four tabs each signed in to another account: each account's address is asked, not the first only.
    const MAIL: KeepSignedInSite = { site: 'mail.example.com', every_minutes: 10, mode: 'session' };
    const accounts = [0, 1, 2, 3].map((n) => ({ id: 7 + n, url: `https://mail.example.com/mail/u/${String(n)}/#inbox` }));
    const four = browser([MAIL], accounts);
    await runKeepSignedInTick(four.deps);
    expect(four.ran).toEqual([[7, 'keepSessionAlive'], [8, 'keepSessionAlive'], [9, 'keepSessionAlive'], [10, 'keepSessionAlive']]);
    expect(four.status('mail.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'kept', said: 'Kept the session in its 4 tabs.' } });
    // Two tabs on one address, another view of it, are one request; when the first cannot send it, the next does.
    const shared = browser([MAIL], [{ id: 7, url: 'https://mail.example.com/mail/u/0/#inbox' },
      { id: 8, url: 'https://mail.example.com/mail/u/0/#sent' }, { id: 9, url: 'https://mail.example.com/mail/u/1/#inbox' }],
    { refusedIn: [7] });
    await runKeepSignedInTick(shared.deps);
    expect(shared.ran).toEqual([[7, 'keepSessionAlive'], [8, 'keepSessionAlive'], [9, 'keepSessionAlive']]);
    expect(shared.status('mail.example.com')).toMatchObject({ last: { what: 'kept', said: 'Kept the session in its 3 tabs.' } });
    // Some kept, some not: said, and next due after its interval.
    const partly = browser([MAIL], [...accounts.slice(0, 3), { ...accounts[3]!, discarded: true }], { refusedIn: [8] });
    await runKeepSignedInTick(partly.deps);
    expect(partly.ran).toEqual([[7, 'keepSessionAlive'], [8, 'keepSessionAlive'], [9, 'keepSessionAlive']]);
    expect(partly.status('mail.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE, last: { at: MONDAY_10, what: 'kept',
      said: 'Kept the session in 2 of its 4 tabs: one could not be reached and one Chrome put to sleep.' } });
    // None reached: tried again at the next tick, as before.
    const none = browser([MAIL], accounts.slice(0, 2), { refusedIn: [7, 8] });
    await runKeepSignedInTick(none.deps);
    expect(none.status('mail.example.com')).toEqual({ last: { at: MONDAY_10, what: 'skipped', said: 'Its page could not be reached.' } });
  });

  it('follow-up 23 — never reloads a page that could not say whether something is typed there', async () => {
    const t = browser([{ ...CONSOLE, mode: 'reload' }], [{ id: 8, windowId: 1, active: false }], { front: 1, refusedIn: [8] });
    await runKeepSignedInTick(t.deps);
    expect(t.reloaded).toEqual([]);
    // Tried again at the next tick, as for a tab holding something typed.
    expect(t.status('console.example.com')).toEqual({ last: { at: MONDAY_10, what: 'skipped',
      said: 'Left alone: one it could not check for something typed.' } });
    // Among others: each reason said, the tab that said nothing is typed reloaded.
    const among = browser([{ ...CONSOLE, mode: 'reload' }], [
      { id: 7, windowId: 1, active: true }, { id: 8, windowId: 1, active: false }, { id: 9, windowId: 1, active: false },
      { id: 10, windowId: 2, active: true }, { id: 11, windowId: 2, active: false },
    ], { front: 1, typedIn: [8], refusedIn: [9, 11] });
    await runKeepSignedInTick(among.deps);
    expect(among.reloaded).toEqual([10]);
    expect(among.status('console.example.com')).toMatchObject({ next_at: MONDAY_10 + 10 * MINUTE, last: { what: 'kept',
      said: 'Reloaded its tab, leaving the one you were using, one holding something typed and not sent '
        + 'and 2 it could not check for something typed.' } });
  });

  it('outside its hours does nothing, and is due as soon as they open; one whose hours ran out stops', async () => {
    const weekend = { days: [0, 6], from: '08:00', to: '18:00' };
    const closed = browser([{ ...CONSOLE, window: weekend }], [{ id: 7 }],
      { statuses: { 'console.example.com': { next_at: MONDAY_10 - MINUTE, last: { at: 1, what: 'kept', said: 'Kept the session.' } } } });
    await runKeepSignedInTick(closed.deps);
    expect(closed.ran).toEqual([]);
    expect(closed.status('console.example.com')).toEqual({ last: { at: 1, what: 'kept', said: 'Kept the session.' } });
    const ranOut = browser([{ ...CONSOLE, window: { until: MONDAY_10 } }], [{ id: 7 }]);
    await runKeepSignedInTick(ranOut.deps);
    expect(ranOut.ran).toEqual([]);
    expect(ranOut.kept[KEEP_SIGNED_IN_KEY]).toEqual([{ ...CONSOLE, window: { until: MONDAY_10 }, off: true }]);
    expect(ranOut.status('console.example.com')).toEqual({ last: { at: MONDAY_10, what: 'stopped', said: 'Its hours ran out, so it stopped.' } });
    // Stopped, it is left alone.
    const stopped = browser([{ ...CONSOLE, off: true }], [{ id: 7 }]);
    await runKeepSignedInTick(stopped.deps);
    expect(stopped.ran).toEqual([]);
  });
});

describe('Keep signed in — a sign-in page (follow-up 26)', () => {
  it('on the listed site, a whole word for signing in in its path; off it, that, its host, or a word with the site to come back to', () => {
    const yes: Array<[string, string]> = [
      ['https://console.example.com/login?next=%2Fprojects', 'console.example.com'],
      ['https://console.example.com/#/login?redirect=%2F', 'console.example.com'],
      ['https://console.example.com/users/sign_in', 'console.example.com'],
      ['https://console.example.com/wp-login.php', 'console.example.com'],
      ['https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F1%2F', 'mail.google.com'],
      ['https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2F', 'google.com'],
      ['https://signin.alibabacloud.com/login.htm?callback=https%3A%2F%2Fmodelstudio.console.alibabacloud.com%2F',
        'modelstudio.console.alibabacloud.com'],
      ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x', 'portal.azure.com'],
      ['https://example.okta.com/oauth2/v1/authorize?redirect_uri=https%3A%2F%2Fconsole.example.com%2Fcallback', 'console.example.com'],
    ];
    const no: Array<[string, string]> = [
      // A console's own pages: its past sign-ins, its settings.
      ['https://console.example.com/settings/login-history', 'console.example.com'],
      ['https://console.example.com/auth/policies', 'console.example.com'],
      ['https://console.example.com/sso', 'console.example.com'],
      ['https://console.example.com/documents/signing-keys', 'console.example.com'],
      // Elsewhere: documentation, another site's sign-in, a link sharing the site's address.
      ['https://docs.example.org/guide/auth/', 'console.example.com'],
      ['https://example.okta.com/oauth2/v1/authorize?redirect_uri=https%3A%2F%2Fother.example.org%2F', 'console.example.com'],
      ['https://social.example.org/share?url=https%3A%2F%2Fconsole.example.com%2F', 'console.example.com'],
      ['https://news.example.org/', 'console.example.com'],
      ['not an address', 'console.example.com'],
      ['chrome://newtab/', 'console.example.com'],
    ];
    for (const [url, site] of yes) expect([url, isSignInPage(url, site)]).toEqual([url, true]);
    for (const [url, site] of no) expect([url, isSignInPage(url, site)]).toEqual([url, false]);
  });
});

describe('Keep signed in — signed out anyway (follow-up 26)', () => {
  it('a tab gone from its site to a sign-in page elsewhere is a sign-out, said with the refreshes before it, and is not refreshed there', async () => {
    const tab: KeepSignedInTab = { id: 7, windowId: 1, active: false, url: 'https://console.example.com/home' };
    const t = browser([CONSOLE], [tab], { front: 1 });
    await runKeepSignedInTick(t.deps);
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toEqual([[7, 'keepSessionAlive'], [7, 'keepSessionAlive']]);
    expect(t.memory()?.kept).toEqual({ 'console.example.com': { at: MONDAY_10 + 10 * MINUTE, since: MONDAY_10 } });
    // 10:14, between two refreshes: the site signs the owner out and sends its tab to its sign-in page. Said at the
    // next tick, with what was last done kept beside it.
    tab.url = 'https://signin.example.net/login.htm?callback=https%3A%2F%2Fconsole.example.com%2Fhome';
    t.clock.at = MONDAY_10 + 14 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 20 * MINUTE,
      last: { at: MONDAY_10 + 10 * MINUTE, what: 'kept', said: 'Kept the session.' },
      signed_out: { at: MONDAY_10 + 14 * MINUTE, said: 'Signed out: its tab went to a sign-in page on signin.example.net, '
        + 'though the Bridge had kept its session every 10 minutes since 10:00.' } });
    // 10:20, due: nothing is sent from a sign-in page, and it is next due after its interval, not at the next tick.
    t.clock.at = MONDAY_10 + 20 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toHaveLength(2);
    expect(t.status('console.example.com')).toMatchObject({ next_at: MONDAY_10 + 30 * MINUTE,
      last: { at: MONDAY_10 + 20 * MINUTE, what: 'skipped', said: 'Its tab is on a sign-in page.' },
      signed_out: { at: MONDAY_10 + 14 * MINUTE } });
    // Half a minute on, nothing changed and nothing is written: the side panel draws its section again on a write.
    const writes: unknown[] = [];
    const set = t.deps.storage.set;
    t.deps.storage.set = async (items) => { writes.push(items); await set(items); };
    t.clock.at += 30_000;
    await runKeepSignedInTick(t.deps);
    expect(writes).toEqual([]);
    // Signed in again: the line goes, and the next refresh, 20 minutes after the one before, starts a run of its own.
    tab.url = 'https://console.example.com/home';
    t.clock.at = MONDAY_10 + 25 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).not.toHaveProperty('signed_out');
    t.clock.at = MONDAY_10 + 30 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toHaveLength(3);
    expect(t.memory()?.kept).toEqual({ 'console.example.com': { at: MONDAY_10 + 30 * MINUTE, since: MONDAY_10 + 30 * MINUTE } });
  });

  it('a tab gone to its site\'s own sign-in page is a sign-out and is not reloaded; refreshes that had stopped are said so', async () => {
    // Reloaded Sunday at 23:50, the computer asleep since.
    const SUNDAY_2350 = new Date(2026, 10, 8, 23, 50).getTime();
    const tabs: KeepSignedInTab[] = [{ id: 7, windowId: 1, active: false, url: 'https://console.example.com/home' },
      { id: 8, windowId: 1, active: false, url: 'https://console.example.com/projects' }];
    const t = browser([{ ...CONSOLE, mode: 'reload' }], tabs, { front: 1, now: SUNDAY_2350 });
    await runKeepSignedInTick(t.deps);
    expect(t.reloaded).toEqual([7, 8]);
    tabs[1]!.url = 'https://console.example.com/login?next=%2Fprojects';
    t.clock.at = MONDAY_10;
    await runKeepSignedInTick(t.deps);
    expect(t.reloaded).toEqual([7, 8, 7]);
    expect(t.ran).toEqual([[7, 'pageHasUnsentInput'], [8, 'pageHasUnsentInput'], [7, 'pageHasUnsentInput']]);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'kept', said: 'Reloaded its tab, leaving one on a sign-in page.' },
      signed_out: { at: MONDAY_10,
        said: 'Signed out: one of its 2 tabs went to a sign-in page. The Bridge had last refreshed it at Sun 23:50.' } });
  });

  it('a tab first seen on a sign-in page is no sign-out; one gone elsewhere, or closed, is forgotten and may sleep again', async () => {
    const tabs: KeepSignedInTab[] = [{ id: 7, url: 'https://console.example.com/login' },
      { id: 8, url: 'https://console.example.com/home' }, { id: 9, url: 'https://console.example.com/billing' }];
    const t = browser([CONSOLE], tabs);
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toEqual([[8, 'keepSessionAlive'], [9, 'keepSessionAlive']]);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'kept', said: 'Kept the session in 2 of its 3 tabs: one on a sign-in page.' } });
    // One follows a link to the site's documentation; another is closed.
    tabs[1]!.url = 'https://docs.example.org/guide/auth/';
    tabs.splice(2, 1);
    t.clock.at += MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).not.toHaveProperty('signed_out');
    expect(t.memory()?.tabs).toEqual({ 7: { site: 'console.example.com', signing_in: true, awake: true } });
    expect(t.updated).toEqual([[7, false], [8, false], [9, false], [8, true]]);
  });

  it('of a site open in several accounts, the one signed out is said, and the others are still kept', async () => {
    const MAIL: KeepSignedInSite = { site: 'mail.example.com', every_minutes: 10, mode: 'session' };
    const tabs: KeepSignedInTab[] = [0, 1, 2].map((n) => ({ id: 7 + n, url: `https://mail.example.com/mail/u/${String(n)}/#inbox` }));
    const t = browser([MAIL], tabs);
    await runKeepSignedInTick(t.deps);
    tabs[1]!.url = 'https://accounts.example.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.example.com%2Fmail%2Fu%2F1%2F';
    t.clock.at = MONDAY_10 + 5 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).toMatchObject({ signed_out: { at: MONDAY_10 + 5 * MINUTE,
      said: 'Signed out: one of its 3 tabs went to a sign-in page on accounts.example.com, though the Bridge had kept '
        + 'its session every 10 minutes since 10:00.' } });
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.ran.slice(3)).toEqual([[7, 'keepSessionAlive'], [9, 'keepSessionAlive']]);
    expect(t.status('mail.example.com')).toMatchObject({ last: { what: 'kept',
      said: 'Kept the session in 2 of its 3 tabs: one on a sign-in page.' }, signed_out: { at: MONDAY_10 + 5 * MINUTE } });
  });
});

describe('Keep signed in — where a refresh\'s request went (follow-up 28)', () => {
  it('a request the site sent on to its sign-in page is a sign-out, said once though the tab still shows the site; signed in again, it goes', async () => {
    const answers: Record<number, unknown> = {};
    const tabs: KeepSignedInTab[] = [{ id: 7, url: 'https://console.example.com/home' }];
    const t = browser([CONSOLE], tabs, { answers });
    await runKeepSignedInTick(t.deps);
    // 10:10: signed out by the site; the page, which does not draw itself again, still shows the console.
    answers[7] = { status: 200, redirected_to: 'https://console.example.com/login?next=%2Fhome' };
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 20 * MINUTE,
      last: { at: MONDAY_10 + 10 * MINUTE, what: 'skipped', said: 'Its tab is signed out.' },
      signed_out: { at: MONDAY_10 + 10 * MINUTE, said: 'Signed out: a refresh from its tab went to a sign-in page, though '
        + 'the Bridge had kept its session every 10 minutes since 10:00.' } });
    expect(t.memory()?.tabs[7]).toEqual({ site: 'console.example.com', awake: true, out: true });
    // Not asked again at the next tick, as a page that could not be reached is: it would answer the same. Nothing written.
    const writes = writesOf(t);
    t.clock.at += 30_000;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toHaveLength(2);
    expect(writes).toEqual([]);
    // 10:20: still sent to the sign-in page: the line stays as it was said, and the run of refreshes does not go on.
    t.clock.at = MONDAY_10 + 20 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ last: { at: MONDAY_10 + 20 * MINUTE, said: 'Its tab is signed out.' },
      signed_out: { at: MONDAY_10 + 10 * MINUTE } });
    expect(t.memory()?.kept).toEqual({ 'console.example.com': { at: MONDAY_10, since: MONDAY_10 } });
    // The owner signs in again in another tab: the line goes before the next refresh, which keeps both.
    tabs.push({ id: 8, url: 'https://console.example.com/login' });
    t.clock.at = MONDAY_10 + 25 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toHaveProperty('signed_out');
    tabs[1]!.url = 'https://console.example.com/home';
    delete answers[7];
    t.clock.at = MONDAY_10 + 26 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).not.toHaveProperty('signed_out');
    expect(t.memory()?.tabs[7]).toEqual({ site: 'console.example.com', awake: true });
    t.clock.at = MONDAY_10 + 30 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 40 * MINUTE,
      last: { at: MONDAY_10 + 30 * MINUTE, what: 'kept', said: 'Kept the session in its 2 tabs.' } });
    expect(t.memory()?.kept).toEqual({ 'console.example.com': { at: MONDAY_10 + 30 * MINUTE, since: MONDAY_10 + 30 * MINUTE } });
    // A request the site sends on to another of its pages, not a sign-in page, kept it.
    answers[7] = { status: 200, redirected_to: 'https://console.example.com/home/' };
    t.clock.at = MONDAY_10 + 40 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 50 * MINUTE,
      last: { at: MONDAY_10 + 40 * MINUTE, what: 'kept', said: 'Kept the session in its 2 tabs.' } });
  });

  it('a tab its request found signed out, then going to its site\'s sign-in page, is not said again', async () => {
    const answers: Record<number, unknown> = {};
    const tab: KeepSignedInTab = { id: 7, url: 'https://console.example.com/home' };
    const t = browser([CONSOLE], [tab], { answers });
    await runKeepSignedInTick(t.deps);
    answers[7] = { status: 200, redirected_to: 'https://console.example.com/login?next=%2Fhome' };
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    tab.url = 'https://console.example.com/login?next=%2Fhome';
    t.clock.at = MONDAY_10 + 12 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { at: MONDAY_10 + 10 * MINUTE } });
    expect(t.memory()?.tabs[7]).toEqual({ site: 'console.example.com', signing_in: true, awake: true });
  });

  it('a request sent on to another site is said as that, asked again after its interval; the tab going to a sign-in page then says since when', async () => {
    const answers: Record<number, unknown> = {};
    const tab: KeepSignedInTab = { id: 7, url: 'https://console.example.com/home' };
    const t = browser([CONSOLE], [tab], { answers });
    await runKeepSignedInTick(t.deps);
    answers[7] = { elsewhere: true };
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toEqual({ next_at: MONDAY_10 + 20 * MINUTE, last: { at: MONDAY_10 + 10 * MINUTE,
      what: 'skipped', said: 'Its page now sends the Bridge\'s request on to another site, as a site does once it has signed you out.' } });
    t.clock.at += 30_000;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toHaveLength(2);
    t.clock.at = MONDAY_10 + 20 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toHaveLength(3);
    expect(t.memory()?.kept).toEqual({ 'console.example.com': { at: MONDAY_10, since: MONDAY_10, away: MONDAY_10 + 10 * MINUTE } });
    // 10:24: the owner comes back to the tab, and the site sends it to its sign-in page.
    tab.url = 'https://signin.example.net/login.htm?callback=https%3A%2F%2Fconsole.example.com%2Fhome';
    t.clock.at = MONDAY_10 + 24 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { at: MONDAY_10 + 24 * MINUTE,
      said: 'Signed out: its tab went to a sign-in page on signin.example.net. The Bridge had kept its session every 10 '
        + 'minutes from 10:00 until 10:10, when the site began sending its requests on to another site.' } });
  });

  it('of a site open in several accounts, the account a request found signed out is said, and the others kept', async () => {
    const MAIL: KeepSignedInSite = { site: 'mail.example.com', every_minutes: 10, mode: 'session' };
    const tabs: KeepSignedInTab[] = [0, 1, 2].map((n) => ({ id: 7 + n, url: `https://mail.example.com/mail/u/${String(n)}/#inbox` }));
    const answers: Record<number, unknown> = {};
    const t = browser([MAIL], tabs, { answers });
    await runKeepSignedInTick(t.deps);
    const accounts = (n: number) => 'https://accounts.example.com/v3/signin/identifier?continue='
      + `https%3A%2F%2Fmail.example.com%2Fmail%2Fu%2F${String(n)}%2F`;
    // The account of the second tab signed out; the site sends its request on to its sign-in page, which lets it be read.
    answers[8] = { status: 200, redirected_to: accounts(1) };
    t.clock.at = MONDAY_10 + 10 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).toEqual({ next_at: MONDAY_10 + 20 * MINUTE,
      last: { at: MONDAY_10 + 10 * MINUTE, what: 'kept', said: 'Kept the session in 2 of its 3 tabs: one signed out.' },
      signed_out: { at: MONDAY_10 + 10 * MINUTE, said: 'Signed out: a refresh from one of its 3 tabs went to a sign-in page '
        + 'on accounts.example.com, though the Bridge had kept its session every 10 minutes since 10:00.' } });
    // The owner opens it and it goes to the sign-in page: said already, not again. Signed in there, the line goes.
    tabs[1]!.url = accounts(1);
    t.clock.at = MONDAY_10 + 12 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).toMatchObject({ signed_out: { at: MONDAY_10 + 10 * MINUTE } });
    tabs[1]!.url = 'https://mail.example.com/mail/u/1/#inbox';
    delete answers[8];
    t.clock.at = MONDAY_10 + 13 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).not.toHaveProperty('signed_out');
    expect(t.memory()?.tabs[8]).toEqual({ site: 'mail.example.com', awake: true, signed_in: MONDAY_10 + 13 * MINUTE });
    // Another account: said; signed in again where the Bridge did not see it, its next request is answered, and the line goes.
    answers[9] = { status: 200, redirected_to: accounts(2) };
    t.clock.at = MONDAY_10 + 20 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).toMatchObject({ signed_out: { at: MONDAY_10 + 20 * MINUTE,
      said: 'Signed out: a refresh from one of its 3 tabs went to a sign-in page on accounts.example.com, though the Bridge '
        + 'had kept its session every 10 minutes since 10:00.' } });
    delete answers[9];
    t.clock.at = MONDAY_10 + 30 * MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.status('mail.example.com')).toEqual({ next_at: MONDAY_10 + 40 * MINUTE,
      last: { at: MONDAY_10 + 30 * MINUTE, what: 'kept', said: 'Kept the session in its 3 tabs.' } });
  });

  it('a tab of a site listed below another is said signed out on its own site\'s card, not on the one above', async () => {
    const GOOGLE: KeepSignedInSite = { site: 'example.com', every_minutes: 10, mode: 'session' };
    const MAIL: KeepSignedInSite = { site: 'mail.example.com', every_minutes: 10, mode: 'session' };
    const answers: Record<number, unknown> = { 7: { status: 200, redirected_to: 'https://accounts.example.com/v3/signin/'
      + 'identifier?continue=https%3A%2F%2Fmail.example.com%2Fmail%2Fu%2F0%2F' } };
    const t = browser([GOOGLE, MAIL], [{ id: 7, url: 'https://mail.example.com/mail/u/0/#inbox' }], { answers });
    await runKeepSignedInTick(t.deps);
    expect(t.ran).toEqual([[7, 'keepSessionAlive'], [7, 'keepSessionAlive']]);
    expect(t.status('example.com')).toEqual({ next_at: MONDAY_10 + 10 * MINUTE,
      last: { at: MONDAY_10, what: 'skipped', said: 'Its tab is signed out.' } });
    expect(t.status('mail.example.com')).toMatchObject({ signed_out: { at: MONDAY_10,
      said: 'Signed out: a refresh from its tab went to a sign-in page on accounts.example.com.' } });
  });
});

describe('Keep signed in — how long a sign-in lasted (follow-up 29)', () => {
  const HOME = 'https://console.example.com/home';
  const SIGN_IN = 'https://signin.example.net/login.htm?callback=https%3A%2F%2Fconsole.example.com%2Fhome';
  /** Monday 10:00 and `minutes` on. */
  const at = (minutes: number): number => MONDAY_10 + minutes * MINUTE;
  /** A tab of the console on its sign-in page at 10:00, where the owner signs in at 10:01. */
  const signingIn = async (extra: { statuses?: Record<string, unknown>; answers?: Record<number, unknown>;
    activity?: { running: number; last_ended_at: number }; } = {}) => {
    const tab: KeepSignedInTab = { id: 7, url: 'https://console.example.com/login' };
    const t = browser([CONSOLE], [tab], { front: null, ...extra });
    await runKeepSignedInTick(t.deps);
    tab.url = HOME;
    t.clock.at = at(1);
    await runKeepSignedInTick(t.deps);
    expect(t.memory()?.tabs[7]).toEqual({ site: 'console.example.com', awake: true, signed_in: at(1) });
    return { t, tab };
  };
  const lastedOf = (t: ReturnType<typeof browser>) => t.status('console.example.com')?.lasted as Parameters<typeof lastedSaid>[0];

  it('a sign-out says how long after the owner signed in; twice about as long, refreshed on time, the card says what that seems', async () => {
    const { t, tab } = await signingIn();
    await ticks(t, at(10), at(360));
    // 16:05: signed out.
    tab.url = SIGN_IN;
    t.clock.at = at(365);
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { at: at(365), said: 'Signed out 6 hours 4 minutes '
      + 'after you signed in: its tab went to a sign-in page on signin.example.net, though the Bridge had kept its session '
      + 'every 10 minutes since 10:10.' }, lasted: { ms: 364 * MINUTE, mode: 'session' } });
    expect(lastedSaid(lastedOf(t), 'session')).toBeUndefined();
    // Signed in again at 16:30, the line gone; signed out again 6 hours 3 minutes on.
    await ticks(t, at(370), at(380));
    tab.url = HOME;
    await ticks(t, at(390), at(750));
    expect(t.status('console.example.com')).not.toHaveProperty('signed_out');
    tab.url = SIGN_IN;
    t.clock.at = at(753);
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { at: at(753), said: 'Signed out 6 hours 3 minutes '
      + 'after you signed in: its tab went to a sign-in page on signin.example.net, though the Bridge had kept its session '
      + 'every 10 minutes since 16:30.' }, lasted: { ms: 363 * MINUTE, mode: 'session', again: 'try_reload' } });
    // Kept by its session both times: its page may be what signs the owner out, which reloading it stops. Not said of
    // a site reloaded now, which is what it advises.
    expect(lastedSaid(lastedOf(t), 'session')).toBe('It signed you out about 6 hours 3 minutes after you signed in, as the '
      + 'time before, though its session was kept on time. Try adding it again with Reload the page: if that does not keep '
      + 'you signed in either, it ends a sign-in a set time after it began, and no refresh helps.');
    expect(lastedSaid(lastedOf(t), 'reload')).toBeUndefined();
    // Added again with Reload the page, signed in again at 23:00, and signed out as long after, though reloaded on time.
    t.kept[KEEP_SIGNED_IN_KEY] = [{ ...CONSOLE, mode: 'reload' }];
    await ticks(t, at(760), at(770));
    tab.url = HOME;
    await ticks(t, at(780), at(1140));
    expect(t.reloaded).toHaveLength(37);
    tab.url = SIGN_IN;
    t.clock.at = at(1143);
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { said: 'Signed out 6 hours 3 minutes after you '
      + 'signed in: its tab went to a sign-in page on signin.example.net, though the Bridge had reloaded it every 10 minutes '
      + 'since Mon 23:00.' }, lasted: { ms: 363 * MINUTE, mode: 'reload', again: 'set_time' } });
    expect(lastedSaid(lastedOf(t), 'reload')).toBe('It signed you out about 6 hours 3 minutes after you signed in, as the '
      + 'time before, though it was refreshed on time: it ends a sign-in a set time after it began, and no refresh helps, '
      + 'so you can stop keeping it.');
  });

  it('a refresh that found the owner signed out says how long after they signed in too', async () => {
    const answers: Record<number, unknown> = {};
    const { t } = await signingIn({ answers });
    await ticks(t, at(10), at(360));
    answers[7] = { status: 200, redirected_to: 'https://console.example.com/login?next=%2Fhome' };
    t.clock.at = at(370);
    await runKeepSignedInTick(t.deps);
    expect(t.status('console.example.com')).toMatchObject({ signed_out: { at: at(370), said: 'Signed out 6 hours 9 minutes '
      + 'after you signed in: a refresh from its tab went to a sign-in page, though the Bridge had kept its session every 10 '
      + 'minutes since 10:10.' }, lasted: { ms: 369 * MINUTE, mode: 'session' } });
  });

  it('one the refreshes had stopped before, or too soon after signing in to tell, is not compared; one lasting otherwise replaces the one before', async () => {
    // The computer asleep from 12:00: said with how long, not kept to compare.
    const asleep = await signingIn();
    await ticks(asleep.t, at(10), at(120));
    asleep.tab.url = SIGN_IN;
    asleep.t.clock.at = at(365);
    await runKeepSignedInTick(asleep.t.deps);
    expect(asleep.t.status('console.example.com')).toMatchObject({ signed_out: { said: 'Signed out 6 hours 4 minutes after '
      + 'you signed in: its tab went to a sign-in page on signin.example.net. The Bridge had last refreshed it at 12:00.' } });
    expect(asleep.t.status('console.example.com')).not.toHaveProperty('lasted');
    // 25 minutes on, under three of its intervals: as a site does whose refreshes come too seldom for it.
    const soon = await signingIn();
    await ticks(soon.t, at(10), at(20));
    soon.tab.url = SIGN_IN;
    soon.t.clock.at = at(26);
    await runKeepSignedInTick(soon.t.deps);
    expect(soon.t.status('console.example.com')).toMatchObject({ signed_out: { said: 'Signed out 25 minutes after you signed '
      + 'in: its tab went to a sign-in page on signin.example.net, though the Bridge had kept its session every 10 minutes '
      + 'since 10:10.' } });
    expect(soon.t.status('console.example.com')).not.toHaveProperty('lasted');
    // Refreshed from 11:00 only, Recued acting in the browser until then: what signed the owner out before is not told.
    const activity = { running: 1, last_ended_at: 0 };
    const late = await signingIn({ activity });
    await ticks(late.t, at(10), at(50));
    activity.running = 0;
    await ticks(late.t, at(60), at(360));
    late.tab.url = SIGN_IN;
    late.t.clock.at = at(365);
    await runKeepSignedInTick(late.t.deps);
    expect(late.t.status('console.example.com')).toMatchObject({ signed_out: { said: 'Signed out 6 hours 4 minutes after '
      + 'you signed in: its tab went to a sign-in page on signin.example.net, though the Bridge had kept its session every '
      + '10 minutes since 11:00.' } });
    expect(late.t.status('console.example.com')).not.toHaveProperty('lasted');
    // 5 hours the time before, 6 hours 4 minutes now: further apart than its interval, 2 minutes and a twentieth allow,
    // so kept in its place, no longer said to seem set. 5 hours 40 minutes the time before is within them.
    for (const [hours, again] of [[300, undefined], [340, 'try_reload']] as const) {
      const prior = { ms: hours * MINUTE, mode: 'session', again: 'try_reload' };
      const other = await signingIn({ statuses: { 'console.example.com': { lasted: prior } } });
      expect(other.t.status('console.example.com')).toMatchObject({ lasted: prior });
      await ticks(other.t, at(10), at(360));
      other.tab.url = SIGN_IN;
      other.t.clock.at = at(365);
      await runKeepSignedInTick(other.t.deps);
      expect([hours, other.t.status('console.example.com')?.lasted])
        .toEqual([hours, { ms: 364 * MINUTE, mode: 'session', ...(again !== undefined ? { again } : {}) }]);
    }
  });

  it('is kept through its hours closing and running out, and nothing is written while nothing changes', async () => {
    const lasted = { ms: 363 * MINUTE, mode: 'session', again: 'try_reload' };
    const kept = { at: 1, what: 'kept', said: 'Kept the session.' };
    const closed = browser([{ ...CONSOLE, window: { days: [0, 6], from: '08:00', to: '18:00' } }], [{ id: 7, url: HOME }],
      { statuses: { 'console.example.com': { next_at: at(-1), last: kept, lasted } } });
    await runKeepSignedInTick(closed.deps);
    expect(closed.status('console.example.com')).toEqual({ last: kept, lasted });
    const writes = writesOf(closed);
    closed.clock.at += MINUTE;
    await runKeepSignedInTick(closed.deps);
    expect(writes).toEqual([]);
    const ranOut = browser([{ ...CONSOLE, window: { until: MONDAY_10 } }], [{ id: 7, url: HOME }],
      { statuses: { 'console.example.com': { lasted } } });
    await runKeepSignedInTick(ranOut.deps);
    expect(ranOut.status('console.example.com')).toEqual({ last: { at: MONDAY_10, what: 'stopped',
      said: 'Its hours ran out, so it stopped.' }, lasted });
  });
});

describe('Keep signed in — tabs kept awake (follow-up 27)', () => {
  it('keeps a kept site\'s tabs awake, and lets each sleep again once it leaves, its hours close or the list empties', async () => {
    const CRM: KeepSignedInSite = { site: 'crm.example.com', every_minutes: 10, mode: 'session',
      window: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } };
    const tabs: KeepSignedInTab[] = [
      { id: 7, url: 'https://console.example.com/home', autoDiscardable: true },
      { id: 8, url: 'https://console.example.com/projects', autoDiscardable: true },
      { id: 9, url: 'https://crm.example.com/deals', autoDiscardable: true },
      { id: 10, url: 'https://news.example.org/', autoDiscardable: true },
      // Marked already, as by a Bridge whose memory an update emptied: taken as the Bridge's.
      { id: 11, url: 'https://console.example.com/billing', autoDiscardable: false },
    ];
    const t = browser([CONSOLE, CRM], tabs);
    await runKeepSignedInTick(t.deps);
    expect(t.updated).toEqual([[7, false], [8, false], [9, false]]);
    t.clock.at += MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.updated).toHaveLength(3);
    // A tab leaves the site: it may sleep again at once.
    tabs[1]!.url = 'https://news.example.org/today';
    t.clock.at += MINUTE;
    await runKeepSignedInTick(t.deps);
    expect(t.updated.slice(3)).toEqual([[8, true]]);
    // The CRM's hours close.
    t.clock.at = new Date(2026, 10, 9, 18, 0).getTime();
    await runKeepSignedInTick(t.deps);
    expect(t.updated.slice(4)).toEqual([[9, true]]);
    // The list emptied, as the side panel's Remove does: the tick that change asks for sets back the rest.
    t.kept[KEEP_SIGNED_IN_KEY] = [];
    await runKeepSignedInTick(t.deps, { refresh: false });
    expect(t.updated.slice(5)).toEqual([[7, true], [11, true]]);
    expect(t.memory()?.tabs).toEqual({});
    expect(tabs.map((tab) => tab.autoDiscardable)).toEqual([true, true, true, true, true]);
  });

  it('a tick asked for while one runs runs after it, so a site removed meanwhile still lets its tabs sleep', async () => {
    const tabs: KeepSignedInTab[] = [{ id: 7, url: 'https://console.example.com/home', autoDiscardable: true }];
    const t = browser([CONSOLE], tabs);
    let answer: (value: unknown) => void = () => undefined;
    t.deps.runInTab = async (tabId, func) => {
      t.ran.push([tabId, func.name]);
      return new Promise((resolve) => { answer = resolve; });
    };
    const first = runKeepSignedInTick(t.deps);
    await vi.waitFor(() => expect(t.ran).toHaveLength(1));
    // Removed while its request is out: the change's tick waits for this one.
    t.kept[KEEP_SIGNED_IN_KEY] = [];
    await runKeepSignedInTick(t.deps, { refresh: false });
    expect(t.updated).toEqual([[7, false]]);
    answer({ status: 200 });
    await first;
    expect(t.updated).toEqual([[7, false], [7, true]]);
  });
});

describe('Keep signed in — its timer', () => {
  it('runs only while the list holds a site, follows the list, and ticks on its own alarm', async () => {
    const heard: { alarm?: (alarm: { name: string }) => void; changed?: (changes: Record<string, unknown>, area: string) => void } = {};
    const alarms = { created: [] as string[], cleared: [] as string[] };
    const kept: Record<string, unknown> = {};
    const updates: Array<[number, boolean]> = [];
    let discardable = true;
    const chrome: KeepSignedInChrome = {
      alarms: {
        create: (name) => { alarms.created.push(name); },
        clear: (name) => { alarms.cleared.push(name); },
        onAlarm: { addListener: (handler) => { heard.alarm = handler; } },
      },
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => key in kept).map((key) => [key, kept[key]])),
          set: async (items) => { Object.assign(kept, items); },
        },
        onChanged: { addListener: (handler) => { heard.changed = handler; } },
      },
      tabs: {
        query: async () => [{ id: 7, url: 'https://console.example.com/', autoDiscardable: discardable }],
        reload: async () => undefined,
        get: async () => ({ id: 7, url: 'https://console.example.com/', autoDiscardable: discardable }),
        update: async (tabId, props) => { updates.push([tabId, props.autoDiscardable]); discardable = props.autoDiscardable; },
      },
      scripting: { executeScript: async () => [{ result: { status: 200 } }] },
    };
    wireKeepSignedIn(chrome, () => ({ running: 0, last_ended_at: 0 }));
    // An empty list: no timer.
    await vi.waitFor(() => expect(alarms.cleared).toEqual([KEEP_SIGNED_IN_ALARM]));
    kept[KEEP_SIGNED_IN_KEY] = [CONSOLE];
    heard.changed!({ [KEEP_SIGNED_IN_KEY]: {} }, 'local');
    await vi.waitFor(() => expect(alarms.created).toEqual([KEEP_SIGNED_IN_ALARM]));
    // Another alarm is not its own.
    heard.alarm!({ name: 'recued.bridge.keepalive' });
    heard.alarm!({ name: KEEP_SIGNED_IN_ALARM });
    await vi.waitFor(() => expect(kept[KEEP_SIGNED_IN_STATUS_KEY]).toMatchObject({ 'console.example.com': { last: { what: 'kept' } } }));
    // Follow-up 27 — its tab kept awake; the list emptied, the timer stops and the tab may sleep again at once.
    expect(updates).toEqual([[7, false]]);
    kept[KEEP_SIGNED_IN_KEY] = [];
    heard.changed!({ [KEEP_SIGNED_IN_KEY]: {} }, 'local');
    await vi.waitFor(() => expect(updates).toEqual([[7, false], [7, true]]));
    expect(alarms.cleared).toEqual([KEEP_SIGNED_IN_ALARM, KEEP_SIGNED_IN_ALARM]);
  });
});
