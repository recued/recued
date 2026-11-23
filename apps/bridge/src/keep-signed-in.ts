/** D-347 follow-up 19 (2026-11-08) — Keep signed in: sites the owner lists in the side panel whose
 *  sign-in the Bridge keeps alive, for a console that signs you out after a short idle time.
 *
 *  The owner's words: it "will need to stay away from the model browser operation". So it runs here,
 *  in the Bridge, on its own timer, with no server and no model, and it leaves the browser alone
 *  while Recued acts in it:
 *   - by default it keeps the session (`session`): a request from each of its tabs' pages to the
 *     page's own address, once per address (follow-up 24: a tab per account), with its sign-in,
 *     which a site that keeps its session on its server takes as activity. Nothing on the page
 *     changes, so the AI's refs and its page handle stay good; it waits only while a Bridge command
 *     runs;
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
 *  Follow-up 23 (2026-11-16): a tab on the Chrome Web Store is left alone ({@link isOnChromeWebStore}), and an
 *  awake page is reloaded only once it has said nothing is typed there, never when it cannot be asked. The owner
 *  listed the store's developer console, `chrome.google.com/webstore/devconsole`: keeping its session failed
 *  at every tick, since Chrome refuses every extension's script on that host, and its reloads ran without the
 *  check for something typed, which Chrome refuses there too. ⚠ The reloads ran and the console still signed
 *  the owner out: no refresh extends a sign-in that ends a set time after it began, as Google documents its
 *  session length to.
 *
 *  Follow-ups 26 and 27 (2026-11-16): at every tick, each tab of a site being kept is remembered and kept awake
 *  (`autoDiscardable` false, set back once its site is no longer kept or the tab leaves it). A remembered tab that
 *  goes to a sign-in page, on the site or off it, is a sign-out the card says, with whether the Bridge had been
 *  refreshing the site on time until then ({@link KeepSignedInStatus.signed_out}); a tab on a sign-in page is not
 *  refreshed. Before, a sign-out read as "No tab shows it." or "Its page could not be reached.", retried at every
 *  tick, or, under a site listed above the sign-in page's, as the sign-in page kept.
 *
 *  Follow-ups 28 and 29 (2026-11-16): a request that keeps the session says where its answer came from. One the site
 *  sent on to its sign-in page is a sign-out, said though the tab still shows the site, as a page that does not
 *  redraw itself goes on showing it; before, it read "Kept the session.". One sent on to another site, which the page
 *  may not follow, is said as that, and asked again after the site's interval, not at every tick. A sign-out is said
 *  with how long after the owner signed in, when the Bridge saw a tab of it come back from a sign-in page; and a
 *  site that signed them out about as long after they signed in twice, refreshed on time throughout, is said in its
 *  card to end a sign-in a set time after it began ({@link KeepSignedInStatus.lasted}).
 *
 *  ⛔ `keepSessionAlive` and `pageHasUnsentInput` are INJECTED, so self-contained. */

import { isOnBlockedSite, normalizeBlockedSite, readBlockedSites } from './permissions/site-grants.js';
import { runSiteListMutation } from './site-list-queue.js';

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
  /** Follow-up 26 — when a tab of it went to a sign-in page, and what the card says of it; kept while a tab of it
   *  is on a sign-in page, so it goes once the owner has signed in again there or closed it. Follow-up 28: or while
   *  a tab's request went to one, until a request from it is answered on the site. */
  signed_out?: { at: number; said: string };
  /** Follow-up 29 — how long its last sign-in lasted that can tell (the Bridge saw it begin, it lasted at least
   *  {@link KEEP_SIGNED_IN_LASTED_INTERVALS} intervals, and every refresh came on time), and how it was kept; `again`
   *  when the one before lasted about as long: then it seems to end a sign-in a set time after it began
   *  (`set_time`), or, kept by its session both times, its page may be what signs the owner out, which a reload
   *  would stop (`try_reload`). Kept until a later one that can tell lasts otherwise ({@link lastedSaid}). */
  lasted?: { ms: number; mode: KeepSignedInSite['mode']; again?: 'set_time' | 'try_reload' };
}

/** Follow-up 26 — the `chrome.storage.session` key of what the Bridge remembers between ticks, never shown: the side
 *  panel draws its section again on a change to `chrome.storage.local` only. Session storage is emptied when Chrome
 *  restarts, when a tab's id means nothing any more and the refreshes have stopped. */
export const KEEP_SIGNED_IN_MEMORY_KEY = 'keep_signed_in_memory';

/** What the Bridge remembers between ticks. */
export interface KeepSignedInMemory {
  /** By tab id: the listed site it was on; whether it was last seen on a sign-in page, there or one it went to from
   *  there; whether the Bridge keeps it awake (follow-up 27), so that only a tab it marked is set back; when the
   *  Bridge saw it come back to its site from a sign-in page, the owner signing in (follow-up 29); whether its
   *  page's request went to a sign-in page, the sign-out said (`out`, follow-up 28). */
  tabs: Record<string, { site: string; signing_in?: true; awake?: true; signed_in?: number; out?: true }>;
  /** By site: when it was last refreshed, and when the run of refreshes that led there began, none of them later
   *  than its interval and {@link KEEP_SIGNED_IN_LATE_MS} allow; and when its requests began to be sent on to another
   *  site (`away`, follow-up 28), as a site does once it has signed the owner out, until one is answered again. */
  kept: Record<string, KeepSignedInRun>;
}

/** A run of refreshes, as {@link KeepSignedInMemory.kept} holds it. */
export interface KeepSignedInRun {
  at: number;
  since: number;
  away?: number;
}

/** Follow-up 26 — how late a refresh can come and still continue the run before it: a tick comes every half minute,
 *  and a refresh waits while Recued acts in the browser. */
export const KEEP_SIGNED_IN_LATE_MS = 2 * 60_000;

/** Follow-up 29 — how many of its intervals a sign-in must have lasted to be compared with the one before. A site
 *  that signs the owner out sooner than its interval allows signs them out within two: one whose refreshes come too
 *  seldom, not one that ends a sign-in a set time after it began. */
export const KEEP_SIGNED_IN_LASTED_INTERVALS = 3;

/** What the Bridge remembers as kept, what cannot be read dropped. */
const memoryOf = (value: unknown): KeepSignedInMemory => {
  const memory: KeepSignedInMemory = { tabs: {}, kept: {} };
  if (value === null || typeof value !== 'object') return memory;
  const { tabs, kept } = value as { tabs?: unknown; kept?: unknown };
  const moment = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at);
  for (const [id, tab] of Object.entries(tabs !== null && typeof tabs === 'object' ? tabs : {})) {
    const one = tab as { site?: unknown; signing_in?: unknown; awake?: unknown; signed_in?: unknown; out?: unknown } | null;
    if (!/^\d+$/.test(id) || one === null || typeof one !== 'object' || typeof one.site !== 'string') continue;
    memory.tabs[id] = { site: one.site, ...(one.signing_in === true ? { signing_in: true as const } : {}),
      ...(one.awake === true ? { awake: true as const } : {}), ...(moment(one.signed_in) ? { signed_in: one.signed_in } : {}),
      ...(one.out === true ? { out: true as const } : {}) };
  }
  for (const [site, run] of Object.entries(kept !== null && typeof kept === 'object' ? kept : {})) {
    const one = run as { at?: unknown; since?: unknown; away?: unknown } | null;
    if (one !== null && typeof one === 'object' && moment(one.at) && moment(one.since)) {
      memory.kept[site] = { at: one.at, since: one.since, ...(moment(one.away) ? { away: one.away } : {}) };
    }
  }
  return memory;
};

/** Follow-up 29 — a length of time as a person says it: `a minute`, `45 minutes`, `an hour`, `6 hours 5 minutes`. */
const lengthSaid = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const inMinutes = rest === 1 ? (hours === 0 ? 'a minute' : '1 minute') : `${String(rest)} minutes`;
  if (hours === 0) return inMinutes;
  const inHours = hours === 1 ? (rest === 0 ? 'an hour' : '1 hour') : `${String(hours)} hours`;
  return rest === 0 ? inHours : `${inHours} ${inMinutes}`;
};

/** Follow-up 29 — what a site's card says of its sign-ins ({@link KeepSignedInStatus.lasted}), kept the way it is
 *  now, or nothing: twice signed out about as long after the owner signed in. `try_reload` is not said of a site
 *  reloaded now, which is what it advises. */
export const lastedSaid = (lasted: KeepSignedInStatus['lasted'], mode: KeepSignedInSite['mode']): string | undefined => {
  if (lasted?.again === undefined || (lasted.again === 'try_reload' && mode === 'reload')) return undefined;
  const said = `It signed you out about ${lengthSaid(lasted.ms)} after you signed in, as the time before, though`;
  return lasted.again === 'set_time'
    ? `${said} it was refreshed on time: it ends a sign-in a set time after it began, and no refresh helps, so you `
      + 'can stop keeping it.'
    : `${said} its session was kept on time. Try adding it again with Reload the page: if that does not keep you `
      + 'signed in either, it ends a sign-in a set time after it began, and no refresh helps.';
};

/** A site's {@link KeepSignedInStatus.lasted} as kept, or undefined when it cannot be read. */
const lastedOf = (value: unknown): KeepSignedInStatus['lasted'] => {
  if (value === null || typeof value !== 'object') return undefined;
  const { ms, mode, again } = value as { ms?: unknown; mode?: unknown; again?: unknown };
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || (mode !== 'session' && mode !== 'reload')) return undefined;
  return { ms, mode, ...(again === 'set_time' || again === 'try_reload' ? { again } : {}) };
};

/** Follow-up 26 — on the listed site, a part of a sign-in page's path (or of what follows `#`, where a page that
 *  draws itself keeps its own) that is a word for signing in, whole: `login`, `log-in`, `logon`, `signin`, `sign-in`,
 *  `sign_in`, `login.htm`, and Google's `ServiceLogin`, `AccountChooser` and `InteractiveLogin`. Not `login-history`,
 *  a console's page of past sign-ins, nor `auth` or `sso`, which may name the site's own settings. */
const SIGN_IN_PATH = /(?:^|[^a-z0-9])(?:log[-_]?[io]n|sign[-_]?in|servicelogin|accountchooser|interactivelogin)(?=[/.?&]|$)/;
/** Off it, a host named for signing in too: `signin.alibabacloud.com`, `login.microsoftonline.com`,
 *  `accounts.google.com`, `sso.example.com`. */
const SIGN_IN_HOST = /(?:^|[.-])(?:log[-_]?[io]n|sign[-_]?in|auth|oauth|sso|idp|adfs|saml|accounts)(?=[.-]|$)/;
/** Or a path with a word for it (`/oauth2/v1/authorize`), when its address also holds one on the site to come back to. */
const SIGN_IN_WORD = /(?:^|[^a-z0-9])(?:log[-_]?[io]n|sign[-_]?in|auth|oauth2?|authorize|authenticate|sso|saml2?)(?![a-z0-9])/;

/** Follow-up 26 — whether `url`, a tab's address, is a sign-in page for `site`, a listed site. On the site, by its
 *  path; off it, by its path, by its host's name, or by a word in its path with an address on the site in its query,
 *  the page to come back to once signed in (Google's `continue=`, Alibaba Cloud's `callback=`, `redirect_uri=`). A
 *  page of documentation that says `auth`, a link that shares the site's address: neither. */
export const isSignInPage = (url: string, site: string): boolean => {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return false;
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') return false;
  const path = `${address.pathname}${address.hash}`.toLowerCase();
  if (SIGN_IN_PATH.test(path)) return true;
  if (isOnBlockedSite(url, [site])) return false;
  if (SIGN_IN_HOST.test(address.hostname.toLowerCase())) return true;
  return SIGN_IN_WORD.test(path)
    && [...address.searchParams.values()].some((value) => /^https?:\/\//i.test(value) && isOnBlockedSite(value, [site]));
};

/** The days, 0 Sunday to 6 Saturday, as the card writes them. */
export const KEEP_SIGNED_IN_DAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = KEEP_SIGNED_IN_DAY_NAMES;
/** A moment as this computer's clock shows it, `HH:MM`. */
export const clockAt = (at: number): string => {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};
/** A moment as a person says it on the day of `now`: `08:01` that day, `Sun 08:01` an earlier one. */
const whenSaid = (at: number, now: number): string => (new Date(at).toDateString() === new Date(now).toDateString()
  ? clockAt(at) : `${DAY_NAMES[new Date(at).getDay()]!} ${clockAt(at)}`);
/** Days as a person writes them: `Mon–Fri` for a run of three or more, else each. */
export const daysSaid = (days: readonly number[]): string => {
  const run = days.length >= 3 && days.every((day, i) => i === 0 || day === days[i - 1]! + 1);
  return run ? `${DAY_NAMES[days[0]!]!}–${DAY_NAMES[days.at(-1)!]!}` : days.map((day) => DAY_NAMES[day]!).join(', ');
};

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

/** The Chrome Web Store's hosts, each with its subdomains, as Chromium's `extension_urls::IsWebstoreDomain`
 *  matches them. Chrome refuses every extension's script on them ("The extensions gallery cannot be
 *  scripted."), whatever the extension was granted; it still lets one reload such a tab. The store's developer
 *  console, `chrome.google.com/webstore/devconsole`, is one of its pages. */
export const CHROME_WEB_STORE_HOSTS: readonly string[] = ['chrome.google.com', 'chromewebstore.google.com'];

/** Whether `url` is a Chrome Web Store page, where Chrome lets no extension in. */
export const isOnChromeWebStore = (url: string): boolean => isOnBlockedSite(url, CHROME_WEB_STORE_HOSTS);

/** Why the Bridge leaves a Chrome Web Store page alone: the card says it when it refuses such a site, and the
 *  timer when a tab on one is all it finds. */
export const KEEP_SIGNED_IN_WEB_STORE_SAID = 'Chrome lets no extension into the Chrome Web Store\'s pages '
  + '(chrome.google.com and chromewebstore.google.com), so the Bridge can neither keep their session nor tell '
  + 'whether a reload would lose something typed there.';

/** Parts of a sentence as a person lists them: `a`, `a and b`, `a, b and c`. */
const listed = (parts: readonly string[]): string => (parts.length <= 1 ? parts[0] ?? ''
  : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`);
/** A count as said before a noun: `one`, `2`. */
const some = (count: number): string => (count === 1 ? 'one' : String(count));

/** The address a tab's request goes to: its own, without the part after `#`, which a request never sends. */
const addressOf = (tab: KeepSignedInTab): string => {
  if (tab.url === undefined) return `tab ${String(tab.id)}`;
  try {
    const url = new URL(tab.url);
    url.hash = '';
    return url.href;
  } catch {
    return tab.url;
  }
};

/** In the page: a request to its own address, with its sign-in, read to its end and dropped. A site
 *  that keeps its session on its server takes it as activity; the page shows nothing new.
 *  Follow-up 28: where the answer came from, when the site sent the request on (`redirected_to`), so that one sent to
 *  its sign-in page is told signed out. One sent on to another site fails, as that site does not let the page read
 *  its answer: asked again without following, the answer says whether the request was sent on (`elsewhere`), which
 *  the page may not see, or the first failed for another reason. */
export const keepSessionAlive = async (): Promise<{ status: number; redirected_to?: string } | { elsewhere: true }
  | { failed: string }> => {
  try {
    const response = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    await response.arrayBuffer().catch(() => undefined);
    return response.redirected ? { status: response.status, redirected_to: response.url } : { status: response.status };
  } catch (error) {
    try {
      const again = await fetch(location.href, { credentials: 'include', cache: 'no-store', redirect: 'manual' });
      if (again.type === 'opaqueredirect') return { elsewhere: true };
      await again.arrayBuffer().catch(() => undefined);
      return { status: again.status };
    } catch {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
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
  /** Whether Chrome may put it to sleep on its own (follow-up 27). */
  autoDiscardable?: boolean;
}

export interface KeepSignedInDeps {
  storage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** `chrome.storage.session`: what the Bridge remembers between ticks ({@link KEEP_SIGNED_IN_MEMORY_KEY}). */
  memory: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  tabs: {
    query(opts: { url: string[] }): Promise<KeepSignedInTab[]>;
    reload(tabId: number): Promise<void>;
    /** The tab as it is now; a throw once it is closed. */
    get(tabId: number): Promise<KeepSignedInTab>;
    update(tabId: number, props: { autoDiscardable: boolean }): Promise<unknown>;
  };
  /** The window the owner is in, or null when Chrome is not the app in front. */
  focusedWindow(): Promise<number | null>;
  /** A function run in a tab's page, in the Bridge's own world; its answer, or a throw. */
  runInTab(tabId: number, func: () => unknown): Promise<unknown>;
  /** Whether a Bridge command is running, and when the last one ended (`queue/dispatcher.ts`). */
  activity(): { running: number; last_ended_at: number };
  now(): number;
}

/** What a refresh did. `done` when it kept a session or reloaded a tab: the run of refreshes goes on, and it is next
 *  due after its interval. `settled` when it did neither, yet another try at the next tick would only be answered
 *  the same (follow-up 28): next due after its interval too. Otherwise it is tried again at the next tick. By tab id
 *  (follow-up 28): `kept`, a request answered on the site; `out`, one sent on to a sign-in page, with that page's
 *  host when it is not the site's; `away`, one sent on to another site. */
type Attempt = { done: boolean; said: string; settled?: true; kept?: number[]; out?: { ids: number[]; host?: string };
  away?: number[] };

/** `session`: a request from each awake tab's page, once per address (follow-up 24). A site open in several
 *  tabs, each signed in to another of its accounts (Gmail's `/mail/u/0/`, `/mail/u/1/`), keeps each account's
 *  sign-in only by a request to that account's address: before, the first tab that answered was the only one
 *  asked. Two tabs on one address are one request, sent from the next of them when the first cannot. `signingIn` more
 *  of its tabs are on a sign-in page, said with them (follow-up 26). A request the site sent on to its sign-in page
 *  kept nothing: those tabs are signed out (follow-up 28). */
const keepSession = async (deps: KeepSignedInDeps, site: string, tabs: KeepSignedInTab[], signingIn: number): Promise<Attempt> => {
  const total = tabs.length + signingIn;
  const awake = tabs.filter((tab) => tab.discarded !== true);
  if (awake.length === 0) {
    return { done: false, said: 'Chrome put its tabs to sleep, so nothing could be sent. Reloading the page keeps one awake.' };
  }
  const byAddress = new Map<string, KeepSignedInTab[]>();
  for (const tab of awake) byAddress.set(addressOf(tab), [...(byAddress.get(addressOf(tab)) ?? []), tab]);
  const kept: number[] = [];
  const out: number[] = [];
  const away: number[] = [];
  let host: string | undefined;
  let unreached = 0;
  for (const sharing of byAddress.values()) {
    let answered: 'kept' | 'out' | 'away' | undefined;
    for (const tab of sharing) {
      try {
        const answer = await deps.runInTab(tab.id!, keepSessionAlive) as { status?: unknown; redirected_to?: unknown;
          elsewhere?: unknown } | null;
        if (answer === null || typeof answer !== 'object') continue;
        if (typeof answer.status === 'number') {
          const to = typeof answer.redirected_to === 'string' ? answer.redirected_to : undefined;
          answered = to !== undefined && isSignInPage(to, site) ? 'out' : 'kept';
          if (answered === 'out' && host === undefined && !isOnBlockedSite(to!, [site])) host = new URL(to!).hostname;
          break;
        }
        if (answer.elsewhere === true) {
          answered = 'away';
          break;
        }
      } catch {
        // The next tab on this address, if there is one.
      }
    }
    const ids = sharing.map((tab) => tab.id!);
    if (answered === 'kept') kept.push(...ids);
    else if (answered === 'out') out.push(...ids);
    else if (answered === 'away') away.push(...ids);
    else unreached += sharing.length;
  }
  const told = { kept, ...(out.length > 0 ? { out: { ids: out, ...(host !== undefined ? { host } : {}) } } : {}),
    ...(away.length > 0 ? { away } : {}) };
  if (kept.length === total) {
    return { done: true, said: total === 1 ? 'Kept the session.' : `Kept the session in its ${String(total)} tabs.`, ...told };
  }
  const asleep = tabs.length - awake.length;
  const left = [...(unreached > 0 ? [`${some(unreached)} could not be reached`] : []),
    ...(asleep > 0 ? [`${some(asleep)} Chrome put to sleep`] : []),
    ...(out.length > 0 ? [`${some(out.length)} signed out`] : []),
    ...(away.length > 0 ? [`${some(away.length)} sent on to another site`] : []),
    ...(signingIn > 0 ? [`${some(signingIn)} on a sign-in page`] : [])];
  if (kept.length > 0) {
    return { done: true, said: `Kept the session in ${String(kept.length)} of its ${String(total)} tabs: ${listed(left)}.`, ...told };
  }
  if (out.length === 0 && away.length === 0) return { done: false, said: 'Its page could not be reached.' };
  // Follow-up 28 — the site answered: asked again at the next tick, it would answer the same.
  const said = out.length === total ? (total === 1 ? 'Its tab is signed out.' : `Its ${String(total)} tabs are signed out.`)
    : away.length === total ? `${total === 1 ? 'Its page now sends the Bridge\'s request'
      : 'Its pages now send the Bridge\'s requests'} on to another site, as a site does once it has signed you out.`
      : `Kept the session in none of its ${String(total)} tabs: ${listed(left)}.`;
  return { done: false, settled: true, said, ...told };
};

/** `reload`: every tab of it but the one the owner is looking at, those holding unsent input, and those whose
 *  page could not say whether they hold any. `signingIn` more of its tabs are on a sign-in page, said with them. */
const reloadTabs = async (deps: KeepSignedInDeps, tabs: KeepSignedInTab[], signingIn: number): Promise<Attempt> => {
  const front = await deps.focusedWindow().catch(() => null);
  let reloaded = 0;
  let using = 0;
  let typed = 0;
  let unasked = 0;
  for (const tab of tabs) {
    if (tab.active === true && front !== null && tab.windowId === front) {
      using += 1;
      continue;
    }
    // A sleeping tab holds nothing typed and runs no script: reloading it wakes it. An awake one is reloaded
    // only once its page has said nothing is typed there (follow-up 23): one that could not be asked, as Chrome
    // refuses the Bridge's script on a page, may hold a draft the reload would lose.
    if (tab.discarded !== true) {
      const unsent = await deps.runInTab(tab.id!, pageHasUnsentInput).catch(() => undefined);
      if (unsent !== false) {
        if (unsent === true) typed += 1;
        else unasked += 1;
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
    ...(typed > 0 ? [`${some(typed)} holding something typed and not sent`] : []),
    ...(unasked > 0 ? [`${some(unasked)} it could not check for something typed`] : []),
    ...(signingIn > 0 ? [`${some(signingIn)} on a sign-in page`] : [])];
  if (reloaded === 0) {
    return { done: false, said: left.length > 0 ? `Left alone: ${listed(left)}.` : 'Its tabs could not be reloaded.' };
  }
  return { done: true, said: `Reloaded ${reloaded === 1 ? 'its tab' : `${String(reloaded)} tabs`}`
    + `${left.length > 0 ? `, leaving ${listed(left)}` : ''}.` };
};

/** Follow-ups 26 and 27, at every tick: each tab of a site being kept is remembered, with whether it shows a sign-in
 *  page, and kept awake. A remembered tab no longer among them is looked up where it went: on a sign-in page for its
 *  site it stays remembered, and may sleep; anywhere else, closed, or its site no longer kept, it is forgotten and set
 *  back. A tab that showed its site and now shows a sign-in page, there or one it went to, is a sign-out, unless where
 *  its request went said so already (follow-up 28): what returns is, by site, how many of its tabs went, the host the
 *  first went to when it is not the site, and the latest the Bridge saw one of them signed in (follow-up 29). A tab
 *  back on its site from a sign-in page is the owner signing in, then; and each tab of that site whose request went to
 *  a sign-in page is taken as signed in too, until a request from it says otherwise. */
const watchTabs = async (deps: KeepSignedInDeps, keeping: ReadonlyMap<string, { tabs: KeepSignedInTab[] }>,
  memory: KeepSignedInMemory, now: number): Promise<Map<string, Went>> => {
  const went = new Map<string, Went>();
  const wentTo = (site: string, url: string, signedIn: number | undefined): void => {
    const before = went.get(site);
    const host = before?.host ?? (isOnBlockedSite(url, [site]) ? undefined : new URL(url).hostname);
    const latest = Math.max(before?.signed_in ?? -Infinity, signedIn ?? -Infinity);
    went.set(site, { count: (before?.count ?? 0) + 1, ...(host !== undefined ? { host } : {}),
      ...(Number.isFinite(latest) ? { signed_in: latest } : {}) });
  };
  const signedInAgain = new Set<string>();
  // A tab under two listed sites, one above the other, is the nearer one's.
  const claimed = new Map<number, { site: string; tab: KeepSignedInTab }>();
  for (const [site, { tabs }] of keeping) {
    for (const tab of tabs) {
      const other = claimed.get(tab.id!);
      if (other === undefined || site.length > other.site.length) claimed.set(tab.id!, { site, tab });
    }
  }
  for (const [id, claim] of claimed) {
    const before = memory.tabs[String(id)];
    const url = claim.tab.url;
    // A tab that went from its site to a sign-in page on another listed site stays its site's.
    const site = before !== undefined && before.site !== claim.site && keeping.has(before.site)
      && url !== undefined && isSignInPage(url, before.site) ? before.site : claim.site;
    const signingIn = url !== undefined && isSignInPage(url, site);
    const same = before?.site === site;
    if (signingIn && same && before.signing_in !== true && before.out !== true) wentTo(site, url, before.signed_in);
    // Follow-up 29 — back on its site from a sign-in page: the owner signed in, now.
    const back = !signingIn && same && before.signing_in === true;
    if (back) signedInAgain.add(site);
    const signedIn = back ? now : !signingIn && same ? before.signed_in : undefined;
    const out = !signingIn && same && before.out === true;
    // Awake while it shows a site being kept. A tab Chrome may already not discard is taken as marked by the Bridge:
    // Chrome empties session storage when the Bridge is updated or reloaded, and its marks would outlast their site.
    let awake = claim.tab.autoDiscardable === false;
    if (!awake) {
      try {
        await deps.tabs.update(id, { autoDiscardable: false });
        awake = true;
      } catch {
        // Closed meanwhile.
      }
    }
    memory.tabs[String(id)] = { site, ...(signingIn ? { signing_in: true as const } : {}),
      ...(awake ? { awake: true as const } : {}), ...(signedIn !== undefined ? { signed_in: signedIn } : {}),
      ...(out ? { out: true as const } : {}) };
  }
  for (const [key, before] of Object.entries(memory.tabs)) {
    if (claimed.has(Number(key))) continue;
    const tab = await deps.tabs.get(Number(key)).catch(() => null);
    if (tab === null) {
      delete memory.tabs[key];
      continue;
    }
    if (before.awake === true && tab.autoDiscardable === false) {
      await deps.tabs.update(Number(key), { autoDiscardable: true }).catch(() => undefined);
    }
    if (keeping.has(before.site) && tab.url !== undefined && isSignInPage(tab.url, before.site)) {
      if (before.signing_in !== true && before.out !== true) wentTo(before.site, tab.url, before.signed_in);
      memory.tabs[key] = { site: before.site, signing_in: true };
    } else {
      delete memory.tabs[key];
    }
  }
  for (const tab of Object.values(memory.tabs)) if (signedInAgain.has(tab.site)) delete tab.out;
  return went;
};

/** A sign-out as the card says it: how many of its tabs, the host of the sign-in page when not the site's, the latest
 *  the Bridge saw one of them signed in, and whether a refresh's request found it rather than a tab going there. */
type Went = { count: number; host?: string; signed_in?: number; by_request?: true };

/** Follow-up 26 — what the card says of a sign-out: where its tab went, and whether the Bridge had been refreshing
 *  the site on time until then, which tells a site that signs you out a set time after you signed in, whatever is
 *  done there, from one the refreshes came too late for. Follow-up 28: a refresh whose request went to a sign-in
 *  page, and the refreshes sent on to another site before it. Follow-up 29: `ms` after the owner signed in. */
const signedOutSaid = (entry: KeepSignedInSite, went: Went, total: number, run: KeepSignedInRun | undefined,
  now: number, ms: number | undefined): string => {
  const which = went.by_request === true
    ? (went.count < total ? `${went.count === 1 ? 'a refresh from one' : `refreshes from ${String(went.count)}`} of its `
      + `${String(total)} tabs` : went.count === 1 ? 'a refresh from its tab' : `refreshes from its ${String(went.count)} tabs`)
    : went.count < total ? `${some(went.count)} of its ${String(total)} tabs`
      : went.count === 1 ? 'its tab' : `its ${String(went.count)} tabs`;
  const said = `Signed out${ms !== undefined ? ` ${lengthSaid(ms)} after you signed in` : ''}: ${which} went to a `
    + `sign-in page${went.host !== undefined ? ` on ${went.host}` : ''}`;
  if (run === undefined) return `${said}.`;
  if ((run.away ?? now) - run.at > entry.every_minutes * 60_000 + KEEP_SIGNED_IN_LATE_MS) {
    return `${said}. The Bridge had last refreshed it at ${whenSaid(run.at, now)}.`;
  }
  const how = `${entry.mode === 'session' ? 'kept its session' : 'reloaded it'} every `
    + `${entry.every_minutes === 1 ? 'minute' : `${String(entry.every_minutes)} minutes`}`;
  if (run.away !== undefined) {
    return `${said}. The Bridge had ${how} from ${whenSaid(run.since, now)} until ${whenSaid(run.away, now)}, when the `
      + 'site began sending its requests on to another site.';
  }
  return `${said}, though the Bridge had ${how} since ${whenSaid(run.since, now)}.`;
};

/** How many of a site's tabs are on a sign-in page, said. */
const onSignInSaid = (count: number): string => (count === 1 ? 'Its tab is on a sign-in page.'
  : `Its ${String(count)} tabs are on a sign-in page.`);

let ticking = false;
let tickAgain = false;

/** One tick of the timer: each listed site that is due, in its window, refreshed, unless Recued is
 *  acting in the browser; what happened kept for the side panel. A site whose hours ran out switches
 *  itself off. Due or not, each site being kept has its tabs watched ({@link watchTabs}); `refresh: false` does no
 *  more, as a change to the list asks, so that a site removed lets its tabs sleep again at once: once the list is
 *  empty, no tick follows. One asked for while another runs runs after it, watching only. */
export const runKeepSignedInTick = async (deps: KeepSignedInDeps, opts: { refresh?: boolean } = {}): Promise<void> => {
  if (ticking) {
    tickAgain = true;
    return;
  }
  ticking = true;
  try {
    await tickOnce(deps, opts.refresh !== false);
    while (tickAgain) {
      tickAgain = false;
      await tickOnce(deps, false);
    }
  } finally {
    ticking = false;
    tickAgain = false;
  }
};

const tickOnce = async (deps: KeepSignedInDeps, refresh: boolean): Promise<void> => {
  const kept = await deps.storage.get([KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_STATUS_KEY]);
  const sites = readKeepSignedIn(kept[KEEP_SIGNED_IN_KEY]);
  const held: Record<string, unknown> = await deps.memory.get([KEEP_SIGNED_IN_MEMORY_KEY]).catch(() => ({}));
  const memory = memoryOf(held[KEEP_SIGNED_IN_MEMORY_KEY]);
  const remembered = JSON.stringify(memory);
  if (sites.length === 0 && Object.keys(memory.tabs).length === 0) return;
  // The owner's list of sites Recued must never use: a tab on one is left alone, and every tab while the list
  // cannot be read, as a command is refused then (`BLOCKED_SITES_UNREADABLE_MESSAGE`).
  const blocked = await readBlockedSites(deps.storage).catch(() => null);
  const before = kept[KEEP_SIGNED_IN_STATUS_KEY];
  const statuses: Record<string, KeepSignedInStatus> = before !== null && typeof before === 'object'
    ? { ...(before as Record<string, KeepSignedInStatus>) } : {};
  const now = deps.now();
  const ranOut: string[] = [];
  // Each site being kept now, with its tabs: on, in its window.
  const keeping = new Map<string, { entry: KeepSignedInSite; tabs: KeepSignedInTab[] }>();
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
    const tabs = (await deps.tabs.query({ url: keepSignedInPatterns(entry.site) }).catch(() => []))
      .filter((tab) => typeof tab.id === 'number');
    keeping.set(entry.site, { entry, tabs });
  }
  // A tab on a site never to use is left alone here too: neither kept awake nor watched; every tab while that list
  // cannot be read.
  const went = await watchTabs(deps, new Map([...keeping].map(([site, { tabs }]) => [site, { tabs: blocked === null ? []
    : tabs.filter((tab) => !isOnBlockedSite(tab.url ?? `https://${site}/`, blocked)) }])), memory, now);
  // What each site's status held before this tick: `statuses` replaces a site's as it goes.
  const prior = (site: string): KeepSignedInStatus | undefined => (before !== null && typeof before === 'object'
    ? (before as Record<string, KeepSignedInStatus | undefined>)[site] : undefined);
  // A sign-out is said with the run of refreshes before it, so before this tick's refresh.
  const events = new Map<string, { at: number; said: string }>();
  // Follow-up 29 — a site's sign-in this tick ended, when it can tell how long a sign-in lasts there.
  const lasted = new Map<string, NonNullable<KeepSignedInStatus['lasted']>>();
  const sayOut = (site: string, entry: KeepSignedInSite, how: Went, total: number): void => {
    const run = memory.kept[site];
    // When it was signed out: by when its requests began to be sent on to another site, if since the owner signed in.
    const outAt = run?.away !== undefined && run.away > (how.signed_in ?? -Infinity) ? run.away : now;
    const ms = how.signed_in !== undefined && outAt > how.signed_in ? outAt - how.signed_in : undefined;
    events.set(site, { at: now, said: signedOutSaid(entry, how, total, run, now, ms) });
    const every = entry.every_minutes * 60_000;
    // Only a sign-in every refresh of which came on time, from the first after the owner signed in to the last, and
    // that lasted long enough not to be one the refreshes came too seldom for.
    if (ms === undefined || run === undefined || outAt - run.at > every + KEEP_SIGNED_IN_LATE_MS
      || run.since > how.signed_in! + every + KEEP_SIGNED_IN_LATE_MS || ms < KEEP_SIGNED_IN_LASTED_INTERVALS * every) return;
    const last = lastedOf(prior(site)?.lasted);
    const alike = last !== undefined && Math.abs(ms - last.ms) <= every + KEEP_SIGNED_IN_LATE_MS + Math.max(ms, last.ms) / 20;
    lasted.set(site, { ms, mode: entry.mode, ...(alike ? { again: entry.mode === 'reload' || last.mode === 'reload'
      ? 'set_time' as const : 'try_reload' as const } : {}) });
  };
  // A site's tabs that went from it to a sign-in page elsewhere, remembered.
  const awayOf = (site: string, tabs: KeepSignedInTab[]): number => Object.entries(memory.tabs).filter(([key, tab]) =>
    tab.site === site && tab.signing_in === true && !tabs.some((one) => one.id === Number(key))).length;
  for (const [site, { entry, tabs }] of keeping) {
    const event = went.get(site);
    if (event !== undefined) sayOut(site, entry, event, tabs.length + awayOf(site, tabs));
  }
  for (const [site, { entry, tabs }] of refresh ? keeping : []) {
    const status = statuses[site] ?? {};
    if (status.next_at !== undefined && now < status.next_at) continue;
    const activity = deps.activity();
    if (activity.running > 0 || (entry.mode === 'reload' && now - activity.last_ended_at < KEEP_SIGNED_IN_QUIET_MS)) {
      // Tried again at the next tick.
      statuses[site] = { ...status, last: { at: now, what: 'skipped', said: 'Recued was acting in the browser.' } };
      continue;
    }
    const next_at = now + entry.every_minutes * 60_000;
    // Follow-up 26 — its tabs that went from it to a sign-in page elsewhere.
    const away = awayOf(site, tabs);
    if (tabs.length === 0) {
      statuses[site] = { next_at, last: { at: now, what: 'skipped', said: away > 0 ? onSignInSaid(away) : 'No tab shows it.' } };
      continue;
    }
    const usable = blocked === null ? []
      : tabs.filter((tab) => !isOnBlockedSite(tab.url ?? `https://${site}/`, blocked));
    if (usable.length === 0) {
      statuses[site] = { next_at, last: { at: now, what: 'skipped', said: blocked === null
        ? 'The list of sites never to use could not be read, so nothing was done.'
        : 'Left alone: it is on your list of sites never to use.' } };
      continue;
    }
    // Follow-up 23 — a Chrome Web Store page runs no script of the Bridge's: neither a request from it nor the
    // check before a reload. A tab on one is left alone, and said when it is all there is.
    const open = usable.filter((tab) => !isOnChromeWebStore(tab.url ?? `https://${site}/`));
    if (open.length === 0) {
      statuses[site] = { next_at, last: { at: now, what: 'skipped', said: `Left alone: ${KEEP_SIGNED_IN_WEB_STORE_SAID}` } };
      continue;
    }
    // Follow-up 26 — a tab on a sign-in page holds no session to keep, and reloading it keeps none.
    const signingIn = open.filter((tab) => tab.url !== undefined && isSignInPage(tab.url, site));
    const refreshable = open.filter((tab) => !signingIn.includes(tab));
    if (refreshable.length === 0) {
      statuses[site] = { next_at, last: { at: now, what: 'skipped', said: onSignInSaid(signingIn.length + away) } };
      continue;
    }
    const attempt = entry.mode === 'session' ? await keepSession(deps, site, refreshable, signingIn.length + away)
      : await reloadTabs(deps, refreshable, signingIn.length + away);
    // Follow-up 28 — a tab whose request was answered on the site is signed in; one whose request went to a sign-in
    // page is signed out, said unless it was already. A tab a site listed below this one keeps is that site's.
    for (const id of attempt.kept ?? []) delete memory.tabs[String(id)]?.out;
    if (attempt.out !== undefined) {
      const mine = attempt.out.ids.map((id) => memory.tabs[String(id)]).filter((tab) => tab?.site === site);
      const fresh = mine.filter((tab) => tab!.out !== true);
      for (const tab of mine) tab!.out = true;
      if (fresh.length > 0 && !events.has(site)) {
        const signedIn = Math.max(...fresh.map((tab) => tab!.signed_in ?? -Infinity));
        sayOut(site, entry, { count: fresh.length, ...(attempt.out.host !== undefined ? { host: attempt.out.host } : {}),
          ...(Number.isFinite(signedIn) ? { signed_in: signedIn } : {}), by_request: true }, tabs.length + away);
      }
    }
    const run = memory.kept[site];
    if (attempt.done) {
      // Follow-up 26 — the run of refreshes goes on while each comes on time.
      memory.kept[site] = { at: now, since: run !== undefined
        && now - run.at <= entry.every_minutes * 60_000 + KEEP_SIGNED_IN_LATE_MS ? run.since : now };
    } else if (attempt.away !== undefined && run !== undefined && run.away === undefined) {
      // Follow-up 28 — the first of its requests sent on to another site: as a site does once it has signed you out.
      memory.kept[site] = { ...run, away: now };
    }
    statuses[site] = attempt.done || attempt.settled === true
      ? { next_at, last: { at: now, what: attempt.done ? 'kept' : 'skipped', said: attempt.said } }
      // Tried again at the next tick.
      : { ...status, last: { at: now, what: 'skipped', said: attempt.said } };
  }
  // A sign-out said this tick, or one said before while a tab of the site is still on a sign-in page or its request
  // still went to one.
  const signedOut = new Map<string, { at: number; said: string }>();
  for (const site of keeping.keys()) {
    const said = prior(site)?.signed_out;
    if (events.has(site)) signedOut.set(site, events.get(site)!);
    else if (said !== undefined && Object.values(memory.tabs).some((tab) => tab.site === site
      && (tab.signing_in === true || tab.out === true))) signedOut.set(site, said);
  }
  for (const site of keeping.keys()) {
    if (statuses[site] === undefined && !signedOut.has(site)) continue;
    const status: KeepSignedInStatus = { ...statuses[site] };
    delete status.signed_out;
    if (signedOut.has(site)) status.signed_out = signedOut.get(site)!;
    statuses[site] = status;
  }
  // Follow-up 29 — how long a listed site's last sign-in that can tell lasted, kept whatever else changed: through its
  // hours closing, and its being switched off.
  for (const { site } of sites) {
    const value = lasted.get(site) ?? lastedOf(prior(site)?.lasted);
    if (value === undefined && statuses[site]?.lasted === undefined) continue;
    const status: KeepSignedInStatus = { ...statuses[site] };
    delete status.lasted;
    if (value !== undefined) status.lasted = value;
    statuses[site] = status;
  }
  for (const site of Object.keys(memory.kept)) {
    if (!sites.some((entry) => entry.site === site)) delete memory.kept[site];
  }
  if (JSON.stringify(memory) !== remembered) {
    await deps.memory.set({ [KEEP_SIGNED_IN_MEMORY_KEY]: memory }).catch(() => undefined);
  }
  // Written only when it changed: the side panel draws its Sites section again on every write.
  if (ranOut.length === 0 && JSON.stringify(statuses) === JSON.stringify(before ?? {})) return;
  await runSiteListMutation(async () => {
    const write: Record<string, unknown> = { [KEEP_SIGNED_IN_STATUS_KEY]: statuses };
    if (ranOut.length > 0) {
      // Read and write within the same queue as panel edits, preserving a
      // removed entry or an owner's replacement window while expiry finishes.
      const now_kept = readKeepSignedIn((await deps.storage.get([KEEP_SIGNED_IN_KEY]))[KEEP_SIGNED_IN_KEY]);
      write[KEEP_SIGNED_IN_KEY] = now_kept.map((entry) => (ranOut.includes(entry.site) && entry.window !== undefined
        && 'until' in entry.window && now >= entry.window.until ? { ...entry, off: true as const } : entry));
    }
    await deps.storage.set(write);
  });
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
    session?: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    onChanged?: { addListener(handler: (changes: Record<string, unknown>, areaName: string) => void): void };
  };
  tabs: {
    query(opts: { url: string[] }): Promise<KeepSignedInTab[]>;
    reload(tabId: number): Promise<void>;
    get(tabId: number): Promise<KeepSignedInTab>;
    update(tabId: number, props: { autoDiscardable: boolean }): Promise<unknown>;
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
  const held: Record<string, unknown> = {};
  const deps: KeepSignedInDeps = {
    storage: c.storage.local,
    // Where session storage is missing, the memory lasts while the worker does.
    memory: c.storage.session ?? {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in held).map((key) => [key, held[key]])),
      set: async (items) => { Object.assign(held, items); },
    },
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
    if (areaName !== 'local' || !(KEEP_SIGNED_IN_KEY in changes)) return;
    void follow().catch(() => undefined);
    // Follow-up 27 — the tabs of a site removed or switched off sleep again now: once the list is empty, no tick follows.
    void runKeepSignedInTick(deps, { refresh: false }).catch(() => undefined);
  });
  void follow().catch(() => undefined);
};
