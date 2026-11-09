/** D-347 follow-up 19 (2026-11-08) — Keep signed in: sites the owner lists in the side panel whose
 *  sign-in the Bridge keeps alive, for a console that signs you out after a short idle time.
 *
 *  The owner's words: it "will need to stay away from the model browser operation". So it runs here,
 *  in the Bridge, on its own timer, with no server and no model, and it leaves the browser alone
 *  while Recued acts in it:
 *   - by default it keeps the session (`session`): a request from a tab's page to the page's own
 *     address, with its sign-in, which a site that keeps its session on its server takes as
 *     activity. Nothing on the page changes, so the AI's refs and its page handle stay good; it
 *     waits only while a Bridge command runs;
 *   - a site whose sign-out timer runs in the page itself is reloaded instead (`reload`, the
 *     owner's choice per site): not while a Bridge command runs or for a minute after the last one
 *     ended ({@link KEEP_SIGNED_IN_QUIET_MS}), as the AI may act again, and never the tab the owner
 *     is using (the one shown in the window they are in) nor one holding something typed and not
 *     sent.
 *  Each site has its interval, 1 to 60 minutes, and may have a window: days and hours, or the
 *  next hours, after which it stops. Outside its window nothing is refreshed, and the site's own
 *  time-out applies. What happened last is kept for the side panel ({@link KEEP_SIGNED_IN_STATUS_KEY}).
 *  The owner's list of sites Recued must never use holds here too (follow-up 20): a tab on one of them is
 *  left alone, and every tab while that list cannot be read.
 *
 *  ⛔ `keepSessionAlive` and `pageHasUnsentInput` are INJECTED, so self-contained. */

import { isOnBlockedSite, normalizeBlockedSite, readBlockedSites } from './permissions/site-grants.js';

/** The `chrome.storage.local` key of the owner's list. */
export const KEEP_SIGNED_IN_KEY = 'keep_signed_in';
/** The `chrome.storage.local` key of what happened last, by site: the side panel reads it. */
export const KEEP_SIGNED_IN_STATUS_KEY = 'keep_signed_in_status';
/** The timer: every half minute, the finest `chrome.alarms` keeps, while the list holds a site. */
export const KEEP_SIGNED_IN_ALARM = 'recued.keep_signed_in';
export const KEEP_SIGNED_IN_PERIOD_MINUTES = 0.5;
export const KEEP_SIGNED_IN_MIN_MINUTES = 1;
export const KEEP_SIGNED_IN_MAX_MINUTES = 60;
export const KEEP_SIGNED_IN_DEFAULT_MINUTES = 10;
/** The most sites the list keeps. */
export const KEEP_SIGNED_IN_MAX_SITES = 20;
/** How long after a Bridge command a page is not reloaded. */
export const KEEP_SIGNED_IN_QUIET_MS = 60_000;

/** Days (0 Sunday to 6 Saturday) and hours (`HH:MM`, `from` before `to`) in this computer's time,
 *  or a moment (`until`, epoch ms) after which the site stops. */
export type KeepSignedInWindow = { days: number[]; from: string; to: string } | { until: number };

export interface KeepSignedInSite {
  /** Its host, lowercase, as the list of blocked sites keeps one: its subdomains too. */
  site: string;
  every_minutes: number;
  /** `session`: a request from the page; `reload`: the page reloaded. */
  mode: 'session' | 'reload';
  window?: KeepSignedInWindow;
  /** Switched itself off: its hours ran out. */
  off?: true;
}

export interface KeepSignedInStatus {
  /** When it is next due; absent while its window is closed or it has not run. */
  next_at?: number;
  last?: { at: number; what: 'kept' | 'skipped' | 'stopped'; said: string };
}

const HOUR = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hour: string): number => {
  const [, h, m] = HOUR.exec(hour)!;
  return Number(h) * 60 + Number(m);
};

/** A window as kept, or null when it is not one. */
const windowOf = (value: unknown): KeepSignedInWindow | null => {
  if (value === null || typeof value !== 'object') return null;
  const kept = value as Record<string, unknown>;
  if (typeof kept.until === 'number' && Number.isFinite(kept.until)) return { until: kept.until };
  if (!Array.isArray(kept.days) || typeof kept.from !== 'string' || typeof kept.to !== 'string') return null;
  const days = [...new Set(kept.days)].filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  if (days.length === 0 || !HOUR.test(kept.from) || !HOUR.test(kept.to) || minutesOf(kept.from) >= minutesOf(kept.to)) {
    return null;
  }
  return { days, from: kept.from, to: kept.to };
};

/** A site as kept, or null when it is not one: what cannot be read is never refreshed. */
export const keepSignedInSiteOf = (value: unknown): KeepSignedInSite | null => {
  if (value === null || typeof value !== 'object') return null;
  const kept = value as Record<string, unknown>;
  const site = typeof kept.site === 'string' ? normalizeBlockedSite(kept.site) : null;
  const every = kept.every_minutes;
  if (site === null || typeof every !== 'number' || !Number.isInteger(every)
    || every < KEEP_SIGNED_IN_MIN_MINUTES || every > KEEP_SIGNED_IN_MAX_MINUTES) return null;
  if (kept.mode !== 'session' && kept.mode !== 'reload') return null;
  const window = kept.window === undefined ? undefined : windowOf(kept.window);
  if (window === null) return null;
  return { site, every_minutes: every, mode: kept.mode, ...(window !== undefined ? { window } : {}),
    ...(kept.off === true ? { off: true as const } : {}) };
};

/** The owner's list as kept: the sites that can be read, the first of each, at most
 *  {@link KEEP_SIGNED_IN_MAX_SITES}. */
export const readKeepSignedIn = (value: unknown): KeepSignedInSite[] => {
  if (!Array.isArray(value)) return [];
  const sites: KeepSignedInSite[] = [];
  for (const entry of value) {
    const site = keepSignedInSiteOf(entry);
    if (site !== null && !sites.some((kept) => kept.site === site.site)) sites.push(site);
  }
  return sites.slice(0, KEEP_SIGNED_IN_MAX_SITES);
};

/** Whether `window` is open at `now`, in this computer's time. No window is always open. */
export const keepSignedInWindowOpen = (window: KeepSignedInWindow | undefined, now: Date): boolean => {
  if (window === undefined) return true;
  if ('until' in window) return now.getTime() < window.until;
  const minute = now.getHours() * 60 + now.getMinutes();
  return window.days.includes(now.getDay()) && minute >= minutesOf(window.from) && minute < minutesOf(window.to);
};

/** The address patterns of a site's tabs: the site and its subdomains. */
export const keepSignedInPatterns = (site: string): string[] => [`*://${site}/*`, `*://*.${site}/*`];

/** In the page: a request to its own address, with its sign-in, read to its end and dropped. A site
 *  that keeps its session on its server takes it as activity; the page shows nothing new. */
export const keepSessionAlive = async (): Promise<{ status: number } | { failed: string }> => {
  try {
    const response = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
};

/** In the page: whether something is typed and not sent there: a field whose value is not the one the
 *  page gave it, or a text editor being written in. A reload would lose it. */
export const pageHasUnsentInput = (): boolean => {
  for (const field of document.querySelectorAll('input, textarea, select')) {
    if (field instanceof HTMLInputElement) {
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked !== field.defaultChecked) return true;
      } else if (!['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(field.type)
        && field.value !== field.defaultValue) return true;
    } else if (field instanceof HTMLTextAreaElement) {
      if (field.value !== field.defaultValue) return true;
    } else if (field instanceof HTMLSelectElement) {
      if ([...field.options].some((option) => option.selected !== option.defaultSelected)) return true;
    }
  }
  const active = document.activeElement;
  return active instanceof HTMLElement && active.isContentEditable;
};

/** A tab as `chrome.tabs.query` answers it. */
export interface KeepSignedInTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  discarded?: boolean;
}

export interface KeepSignedInDeps {
  storage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  tabs: {
    query(opts: { url: string[] }): Promise<KeepSignedInTab[]>;
    reload(tabId: number): Promise<void>;
  };
  /** The window the owner is in, or null when Chrome is not the app in front. */
  focusedWindow(): Promise<number | null>;
  /** A function run in a tab's page, in the Bridge's own world; its answer, or a throw. */
  runInTab(tabId: number, func: () => unknown): Promise<unknown>;
  /** Whether a Bridge command is running, and when the last one ended (`queue/dispatcher.ts`). */
  activity(): { running: number; last_ended_at: number };
  now(): number;
}

type Attempt = { done: boolean; said: string };

/** `session`: the first tab that can run the request does. */
const keepSession = async (deps: KeepSignedInDeps, tabs: KeepSignedInTab[]): Promise<Attempt> => {
  const awake = tabs.filter((tab) => tab.discarded !== true);
  if (awake.length === 0) {
    return { done: false, said: 'Chrome put its tabs to sleep, so nothing could be sent. Reloading the page keeps one awake.' };
  }
  for (const tab of awake) {
    try {
      const answer = await deps.runInTab(tab.id!, keepSessionAlive) as { status?: unknown } | null;
      if (answer !== null && typeof answer === 'object' && typeof answer.status === 'number') {
        return { done: true, said: 'Kept the session.' };
      }
    } catch {
      // The next tab, if there is one.
    }
  }
  return { done: false, said: 'Its page could not be reached.' };
};

/** `reload`: every tab of it but the one the owner is looking at and those holding unsent input. */
const reloadTabs = async (deps: KeepSignedInDeps, tabs: KeepSignedInTab[]): Promise<Attempt> => {
  const front = await deps.focusedWindow().catch(() => null);
  let reloaded = 0;
  let using = 0;
  let typed = 0;
  for (const tab of tabs) {
    if (tab.active === true && front !== null && tab.windowId === front) {
      using += 1;
      continue;
    }
    // A sleeping tab holds nothing typed and runs no script: reloading it wakes it.
    if (tab.discarded !== true) {
      const unsent = await deps.runInTab(tab.id!, pageHasUnsentInput).catch(() => false);
      if (unsent === true) {
        typed += 1;
        continue;
      }
    }
    try {
      await deps.tabs.reload(tab.id!);
      reloaded += 1;
    } catch {
      // Gone meanwhile.
    }
  }
  const left = [...(using > 0 ? ['the one you were using'] : []),
    ...(typed > 0 ? [`${typed === 1 ? 'one' : String(typed)} holding something typed and not sent`] : [])];
  if (reloaded === 0) {
    return { done: false, said: left.length > 0 ? `Left alone: ${left.join(' and ')}.` : 'Its tabs could not be reloaded.' };
  }
  return { done: true, said: `Reloaded ${reloaded === 1 ? 'its tab' : `${String(reloaded)} tabs`}`
    + `${left.length > 0 ? `, leaving ${left.join(' and ')}` : ''}.` };
};

let ticking = false;

/** One tick of the timer: each listed site that is due, in its window, refreshed, unless Recued is
 *  acting in the browser; what happened kept for the side panel. A site whose hours ran out switches
 *  itself off. */
export const runKeepSignedInTick = async (deps: KeepSignedInDeps): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    const kept = await deps.storage.get([KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_STATUS_KEY]);
    const sites = readKeepSignedIn(kept[KEEP_SIGNED_IN_KEY]);
    if (sites.length === 0) return;
    // The owner's list of sites Recued must never use: a tab on one is left alone, and every tab while the list
    // cannot be read, as a command is refused then (`BLOCKED_SITES_UNREADABLE_MESSAGE`).
    const blocked = await readBlockedSites(deps.storage).catch(() => null);
    const before = kept[KEEP_SIGNED_IN_STATUS_KEY];
    const statuses: Record<string, KeepSignedInStatus> = before !== null && typeof before === 'object'
      ? { ...(before as Record<string, KeepSignedInStatus>) } : {};
    const now = deps.now();
    const ranOut: string[] = [];
    for (const entry of sites) {
      if (entry.off === true) continue;
      const status = statuses[entry.site] ?? {};
      if (entry.window !== undefined && 'until' in entry.window && now >= entry.window.until) {
        ranOut.push(entry.site);
        statuses[entry.site] = { last: { at: now, what: 'stopped', said: 'Its hours ran out, so it stopped.' } };
        continue;
      }
      if (!keepSignedInWindowOpen(entry.window, new Date(now))) {
        // Due as soon as it opens.
        statuses[entry.site] = status.last !== undefined ? { last: status.last } : {};
        continue;
      }
      if (status.next_at !== undefined && now < status.next_at) continue;
      const activity = deps.activity();
      if (activity.running > 0 || (entry.mode === 'reload' && now - activity.last_ended_at < KEEP_SIGNED_IN_QUIET_MS)) {
        // Tried again at the next tick.
        statuses[entry.site] = { ...status, last: { at: now, what: 'skipped', said: 'Recued was acting in the browser.' } };
        continue;
      }
      const next_at = now + entry.every_minutes * 60_000;
      const tabs = (await deps.tabs.query({ url: keepSignedInPatterns(entry.site) }).catch(() => []))
        .filter((tab) => typeof tab.id === 'number');
      if (tabs.length === 0) {
        statuses[entry.site] = { next_at, last: { at: now, what: 'skipped', said: 'No tab shows it.' } };
        continue;
      }
      const usable = blocked === null ? []
        : tabs.filter((tab) => !isOnBlockedSite(tab.url ?? `https://${entry.site}/`, blocked));
      if (usable.length === 0) {
        statuses[entry.site] = { next_at, last: { at: now, what: 'skipped', said: blocked === null
          ? 'The list of sites never to use could not be read, so nothing was done.'
          : 'Left alone: it is on your list of sites never to use.' } };
        continue;
      }
      const attempt = entry.mode === 'session' ? await keepSession(deps, usable) : await reloadTabs(deps, usable);
      statuses[entry.site] = attempt.done ? { next_at, last: { at: now, what: 'kept', said: attempt.said } }
        // Tried again at the next tick.
        : { ...status, last: { at: now, what: 'skipped', said: attempt.said } };
    }
    // Written only when it changed: the side panel draws its Sites section again on every write.
    if (ranOut.length === 0 && JSON.stringify(statuses) === JSON.stringify(before ?? {})) return;
    const write: Record<string, unknown> = { [KEEP_SIGNED_IN_STATUS_KEY]: statuses };
    if (ranOut.length > 0) {
      // Read again, so a site the owner added or changed meanwhile is kept as they left it.
      const now_kept = readKeepSignedIn((await deps.storage.get([KEEP_SIGNED_IN_KEY]))[KEEP_SIGNED_IN_KEY]);
      write[KEEP_SIGNED_IN_KEY] = now_kept.map((entry) => (ranOut.includes(entry.site) && entry.window !== undefined
        && 'until' in entry.window && now >= entry.window.until ? { ...entry, off: true as const } : entry));
    }
    await deps.storage.set(write);
  } finally {
    ticking = false;
  }
};

/** The `chrome.*` this needs, as the service worker binds them. */
export interface KeepSignedInChrome {
  alarms: {
    create(name: string, opts: { periodInMinutes: number }): void;
    clear(name: string): void;
    onAlarm: { addListener(handler: (alarm: { name: string }) => void): void };
  };
  storage: {
    local: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    onChanged?: { addListener(handler: (changes: Record<string, unknown>, areaName: string) => void): void };
  };
  tabs: {
    query(opts: { url: string[] }): Promise<KeepSignedInTab[]>;
    reload(tabId: number): Promise<void>;
  };
  windows?: { getLastFocused(): Promise<{ id?: number; focused?: boolean }> };
  scripting: {
    executeScript(opts: { target: { tabId: number }; func: () => unknown }): Promise<Array<{ result?: unknown }>>;
  };
}

/** Wired when the service worker loads, before its first `await`, so an alarm that wakes it finds
 *  its listener. The timer runs only while the list holds a site, and follows the list's changes. */
export const wireKeepSignedIn = (chrome: KeepSignedInChrome | undefined,
  activity: () => { running: number; last_ended_at: number }): void => {
  if (chrome?.alarms === undefined || chrome.storage?.local === undefined) return;
  const c = chrome;
  const deps: KeepSignedInDeps = {
    storage: c.storage.local,
    tabs: c.tabs,
    async focusedWindow() {
      if (c.windows === undefined) return null;
      const front = await c.windows.getLastFocused();
      return front.focused === true && typeof front.id === 'number' ? front.id : null;
    },
    async runInTab(tabId, func) {
      const results = await c.scripting.executeScript({ target: { tabId }, func });
      return results?.[0]?.result;
    },
    activity,
    now: () => Date.now(),
  };
  const follow = async () => {
    const listed = readKeepSignedIn((await c.storage.local.get([KEEP_SIGNED_IN_KEY]))[KEEP_SIGNED_IN_KEY])
      .some((entry) => entry.off !== true);
    if (listed) c.alarms.create(KEEP_SIGNED_IN_ALARM, { periodInMinutes: KEEP_SIGNED_IN_PERIOD_MINUTES });
    else c.alarms.clear(KEEP_SIGNED_IN_ALARM);
  };
  c.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_SIGNED_IN_ALARM) void runKeepSignedInTick(deps).catch(() => undefined);
  });
  c.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'local' && KEEP_SIGNED_IN_KEY in changes) void follow().catch(() => undefined);
  });
  void follow().catch(() => undefined);
};
