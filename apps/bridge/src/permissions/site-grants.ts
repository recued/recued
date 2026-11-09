/** D-335 slice G — where the Bridge may act, as the owner decides it.
 *
 *  - **The site grant.** A Recued kernel DOM step (publisher `recued`: the
 *    `core.dom.*` ops' ingredients and the element watch) runs on the sites
 *    Chrome has granted this extension. The owner grants them from the side
 *    panel ("Allow every site", `EVERY_SITE`) or in Chrome's own settings.
 *    Chrome keeps that grant and takes it back at once, so the Bridge reads it
 *    on every command rather than keeping a copy. ⛔ Before this, the
 *    per-ingredient store (`grants.ts`) was the only grant and nothing wrote
 *    it: the shipped extension refused every page command. A third party's
 *    ingredient still needs its own grant there.
 *  - **The owner's list.** Sites Recued must never use, entered in the side
 *    panel and kept in `chrome.storage.local`. Every command refuses a page on
 *    one before anything is read or done there (`executor.ts`). The list lives
 *    here rather than on the server because only the Bridge sees a page's
 *    address when it acts. */

import type { BridgeGrantStore } from './grants.js';

/** Every `http` and `https` site: what "Allow every site" asks Chrome for, and
 *  the Browser Toolkit's target. */
export const EVERY_SITE = '*://*/*';

/** D-335 slice H — what "Allow screenshots" asks Chrome for, on top of every
 *  site: Chrome captures a tab only for an extension holding `<all_urls>` (or
 *  `activeTab`, which needs a click on the Bridge's icon). Invariant I-9, as
 *  amended 2026-11-01: never in the manifest's `host_permissions`, only as an
 *  optional grant the owner asks for here. Its pages are still read only where
 *  {@link EVERY_SITE} allows, since nothing matches against this pattern. */
export const SCREENSHOTS_GRANT = '<all_urls>';

/** The kernel's publisher: its ingredients ship with the server. */
const KERNEL_PUBLISHER = 'recued';

/** A grant store in which a kernel ingredient's grant is the origins Chrome has
 *  granted this extension, read when asked. Any other publisher's grant comes
 *  from `fallback`. */
export const createKernelSiteGrantStore = (deps: {
  /** The origins Chrome has granted this extension now (`permissions.getAll`). */
  grantedOrigins: () => Promise<readonly string[]>;
  fallback: BridgeGrantStore;
}): BridgeGrantStore => ({
  async get(publisher_id, slug, version) {
    if (publisher_id !== KERNEL_PUBLISHER) return deps.fallback.get(publisher_id, slug, version);
    let origins: readonly string[];
    try {
      origins = await deps.grantedOrigins();
    } catch {
      return null;
    }
    return origins.length === 0 ? null : { publisher_id, slug, version, granted_origins: [...origins], granted_at: 0 };
  },
  put: grant => deps.fallback.put(grant),
  remove: (publisher_id, slug, version) => deps.fallback.remove(publisher_id, slug, version),
  list: () => deps.fallback.list(),
  clear: () => deps.fallback.clear(),
});

/** The `chrome.storage.local` key of the owner's list: hosts, lowercase. */
export const BLOCKED_SITES_KEY = 'blocked_sites';

/** The most sites the list keeps. */
export const BLOCKED_SITES_MAX = 200;

/** What a command on a listed site answers. Nothing was read or done. */
export const BLOCKED_SITE_MESSAGE =
  'The owner listed this site as one Recued must never use, so nothing was read or done there.';

/** What a command answers when the owner's list cannot be read: it cannot tell
 *  a listed site from any other, so it acts on none. */
export const BLOCKED_SITES_UNREADABLE_MESSAGE =
  'The Browser Bridge could not read the owner\'s list of sites Recued must never use, so it did nothing.';

/** A site as the owner typed it, as the list keeps it: its host, lowercase.
 *  "https://Mail.Example.com/inbox", "mail.example.com" and
 *  "mail.example.com/x" are all `mail.example.com`. Null when the text names no
 *  web host. */
export const normalizeBlockedSite = (input: string): string | null => {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
};

/** Whether `url` is on a listed site: the site or one of its subdomains, so
 *  `example.com` covers `www.example.com`. */
export const isOnBlockedSite = (url: string, blocked: readonly string[]): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return host !== '' && blocked.some(site => host === site || host.endsWith(`.${site}`));
};

/** The owner's list as kept. None kept is an empty list; a kept value that is
 *  not a list of sites throws, since treating it as empty would act on sites
 *  the owner listed. */
export const readBlockedSites = async (
  storage: { get(keys: string[]): Promise<Record<string, unknown>> },
): Promise<string[]> => {
  const kept = (await storage.get([BLOCKED_SITES_KEY]))[BLOCKED_SITES_KEY];
  if (kept === undefined) return [];
  if (!Array.isArray(kept)) throw new Error('bridge: the list of blocked sites is not a list');
  return kept.map(entry => {
    const site = typeof entry === 'string' ? normalizeBlockedSite(entry) : null;
    if (site === null) throw new Error('bridge: the list of blocked sites holds something that is not a site');
    return site;
  });
};
