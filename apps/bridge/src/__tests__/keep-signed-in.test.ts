/** D-347 follow-up 19 — Keep signed in (`keep-signed-in.ts`): the owner's list as kept, its windows, and what
 *  one tick of its timer does, over injected `chrome.*`. The two functions it runs in a page are driven in
 *  real Chrome (`backend/server/src/__tests__/bridge-keep-signed-in-browser.test.ts`). */

import { describe, expect, it, vi } from 'vitest';
import {
  KEEP_SIGNED_IN_ALARM,
  KEEP_SIGNED_IN_KEY,
  KEEP_SIGNED_IN_MAX_SITES,
  KEEP_SIGNED_IN_STATUS_KEY,
  keepSessionAlive,
  keepSignedInWindowOpen,
  pageHasUnsentInput,
  readKeepSignedIn,
  runKeepSignedInTick,
  wireKeepSignedIn,
  type KeepSignedInChrome,
  type KeepSignedInDeps,
  type KeepSignedInSite,
  type KeepSignedInTab,
} from '../keep-signed-in.js';
import { BLOCKED_SITES_KEY } from '../permissions/site-grants.js';

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
});

/** A browser the test holds: what is kept, the tabs, the window the owner is in, what a page answers, and
 *  whether a command runs. */
const browser = (sites: KeepSignedInSite[], tabs: KeepSignedInTab[], extra: {
  statuses?: Record<string, unknown>; front?: number | null; typedIn?: number[];
  activity?: { running: number; last_ended_at: number }; now?: number; blocked?: unknown;
} = {}) => {
  const kept: Record<string, unknown> = { [KEEP_SIGNED_IN_KEY]: sites, ...(extra.statuses ? { [KEEP_SIGNED_IN_STATUS_KEY]: extra.statuses } : {}),
    ...(extra.blocked !== undefined ? { [BLOCKED_SITES_KEY]: extra.blocked } : {}) };
  const ran: Array<[number, string]> = [];
  const reloaded: number[] = [];
  const deps: KeepSignedInDeps = {
    storage: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in kept).map((key) => [key, kept[key]])),
      set: async (items) => { Object.assign(kept, items); },
    },
    tabs: {
      query: async () => tabs,
      reload: async (tabId) => { reloaded.push(tabId); },
    },
    focusedWindow: async () => (extra.front === undefined ? 1 : extra.front),
    runInTab: async (tabId, func) => {
      ran.push([tabId, func.name]);
      if (func === keepSessionAlive) return { status: 200 };
      if (func === pageHasUnsentInput) return (extra.typedIn ?? []).includes(tabId);
      throw new Error('unexpected function');
    },
    activity: () => extra.activity ?? { running: 0, last_ended_at: 0 },
    now: () => extra.now ?? MONDAY_10,
  };
  const status = (site: string) => (kept[KEEP_SIGNED_IN_STATUS_KEY] as Record<string, Record<string, unknown>> | undefined)?.[site];
  return { deps, kept, ran, reloaded, status };
};
const CONSOLE: KeepSignedInSite = { site: 'console.example.com', every_minutes: 10, mode: 'session' };

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
    expect(unreadable.status('console.example.com')).toMatchObject({ last: { what: 'skipped',
      said: 'The list of sites never to use could not be read, so nothing was done.' } });
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

describe('Keep signed in — its timer', () => {
  it('runs only while the list holds a site, follows the list, and ticks on its own alarm', async () => {
    const heard: { alarm?: (alarm: { name: string }) => void; changed?: (changes: Record<string, unknown>, area: string) => void } = {};
    const alarms = { created: [] as string[], cleared: [] as string[] };
    const kept: Record<string, unknown> = {};
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
      tabs: { query: async () => [{ id: 7 }], reload: async () => undefined },
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
  });
});
