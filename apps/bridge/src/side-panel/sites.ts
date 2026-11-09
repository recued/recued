/** D-335 slice G — what the side panel's Sites section does: Chrome's grant of
 *  every site, and the owner's list of sites Recued must never use
 *  (`permissions/site-grants.ts`). Over injected `chrome.permissions` and
 *  `chrome.storage.local`, so it is tested without a browser;
 *  `side-panel-entry.ts` binds it. */

import {
  BLOCKED_SITES_KEY,
  BLOCKED_SITES_MAX,
  EVERY_SITE,
  readBlockedSites,
  SCREENSHOTS_GRANT,
} from '../permissions/site-grants.js';
import {
  KEEP_SIGNED_IN_KEY,
  KEEP_SIGNED_IN_MAX_SITES,
  KEEP_SIGNED_IN_STATUS_KEY,
  readKeepSignedIn,
  type KeepSignedInSite,
  type KeepSignedInStatus,
} from '../keep-signed-in.js';
import type { SidePanelKeepRow, SidePanelSitesState } from './store/local-store.js';
import type { SitesHandlers } from './views.js';

export interface SitesChrome {
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    request(permissions: { origins: string[] }): Promise<boolean>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
}

const NOT_ALLOWED = 'Chrome did not allow every site, so nothing changed.';
const SCREENSHOTS_NOT_ALLOWED = 'Chrome did not allow screenshots, so nothing changed.';
const NOT_SAVED = 'Could not save the list. Try again.';
const LIST_UNREADABLE = 'Your list of sites could not be read, so the Bridge acts on no page until it is. '
  + 'Adding or removing a site saves it again.';

/** The Sites section's handlers, and `refresh`, which reads both from Chrome
 *  and hands them to `apply`. Call it on open and on each change Chrome
 *  reports. */
export const createSitesControls = (
  chrome: SitesChrome,
  apply: (sites: SidePanelSitesState) => void,
): Required<SitesHandlers> & { refresh(): Promise<void> } => {
  /** Why the last change did not go through; '' when it did. */
  let message = '';
  /** D-347 follow-up 22 — the same for Keep signed in, said in its own card. */
  let keepMessage = '';
  let generation = 0;

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let every_site: boolean | null = null;
    let screenshots: boolean | null = null;
    let blocked: string[] = [];
    let note = message;
    try {
      every_site = await chrome.permissions.contains({ origins: [EVERY_SITE] });
    } catch {
      every_site = null;
    }
    try {
      screenshots = await chrome.permissions.contains({ origins: [SCREENSHOTS_GRANT] });
    } catch {
      screenshots = null;
    }
    try {
      blocked = await readBlockedSites(chrome.storage);
    } catch {
      note = LIST_UNREADABLE;
    }
    // D-347 follow-up 19 — Keep signed in, with what happened last.
    let keep: SidePanelKeepRow[] = [];
    try {
      const kept = await chrome.storage.get([KEEP_SIGNED_IN_KEY, KEEP_SIGNED_IN_STATUS_KEY]);
      const statuses = kept[KEEP_SIGNED_IN_STATUS_KEY];
      keep = readKeepSignedIn(kept[KEEP_SIGNED_IN_KEY]).map((entry) => {
        const status = statuses !== null && typeof statuses === 'object'
          ? (statuses as Record<string, KeepSignedInStatus>)[entry.site] : undefined;
        return status === undefined ? { entry } : { entry, status };
      });
    } catch {
      keep = [];
    }
    // Only the newest read applies: an older one may predate the change.
    if (mine === generation) {
      apply({ every_site, screenshots, blocked, message: note, keep, ...(keepMessage !== '' ? { keep_message: keepMessage } : {}) });
    }
  };
  const settle = async (next: string): Promise<void> => {
    message = next;
    await refresh();
  };
  const settleKeep = async (next: string): Promise<void> => {
    keepMessage = next;
    await refresh();
  };
  /** The list as it reads now. One that cannot be read is written afresh. */
  const currentList = (): Promise<string[]> => readBlockedSites(chrome.storage).catch(() => []);
  /** D-347 follow-up 19 — Keep signed in's list as it reads now. */
  const currentKeep = async (): Promise<KeepSignedInSite[]> => {
    try {
      return readKeepSignedIn((await chrome.storage.get([KEEP_SIGNED_IN_KEY]))[KEEP_SIGNED_IN_KEY]);
    } catch {
      return [];
    }
  };
  const saveKeep = async (list: KeepSignedInSite[]): Promise<void> => {
    try {
      await chrome.storage.set({ [KEEP_SIGNED_IN_KEY]: list });
    } catch {
      return settleKeep(NOT_SAVED);
    }
    return settleKeep('');
  };
  const save = async (list: string[]): Promise<void> => {
    try {
      await chrome.storage.set({ [BLOCKED_SITES_KEY]: list });
    } catch {
      return settle(NOT_SAVED);
    }
    return settle('');
  };

  return {
    refresh,
    onAllowEverySite() {
      // ⚠ Asked before anything is awaited: Chrome grants a site only while
      // the click's gesture lasts.
      let asked: Promise<boolean>;
      try {
        asked = chrome.permissions.request({ origins: [EVERY_SITE] });
      } catch {
        return settle(NOT_ALLOWED);
      }
      return asked.then(granted => settle(granted ? '' : NOT_ALLOWED), () => settle(NOT_ALLOWED));
    },
    async onStopEverySite() {
      // Screenshots too: their grant covers every site as well, so leaving it
      // would leave Chrome's access to every page in place.
      let removed = false;
      try {
        removed = await chrome.permissions.remove({ origins: [EVERY_SITE, SCREENSHOTS_GRANT] });
      } catch {
        removed = false;
      }
      return settle(removed ? '' : 'Chrome did not take back every site. You can remove it in Chrome\'s settings for the extension.');
    },
    onAllowScreenshots() {
      // ⚠ Asked before anything is awaited, as every site is: Chrome grants it
      // only while the click's gesture lasts.
      let asked: Promise<boolean>;
      try {
        asked = chrome.permissions.request({ origins: [SCREENSHOTS_GRANT] });
      } catch {
        return settle(SCREENSHOTS_NOT_ALLOWED);
      }
      return asked.then(granted => settle(granted ? '' : SCREENSHOTS_NOT_ALLOWED), () => settle(SCREENSHOTS_NOT_ALLOWED));
    },
    async onStopScreenshots() {
      let removed = false;
      try {
        removed = await chrome.permissions.remove({ origins: [SCREENSHOTS_GRANT] });
      } catch {
        removed = false;
      }
      return settle(removed ? '' : 'Chrome did not take back screenshots. You can remove it in Chrome\'s settings for the extension.');
    },
    async onAddBlocked(site) {
      const list = await currentList();
      if (list.includes(site)) return settle('');
      if (list.length >= BLOCKED_SITES_MAX) return settle(`The list holds at most ${BLOCKED_SITES_MAX} sites.`);
      return save([...list, site]);
    },
    async onRemoveBlocked(site) {
      return save((await currentList()).filter(listed => listed !== site));
    },
    // D-347 follow-up 19 — a site added again takes the settings it is added with.
    async onAddKeep(entry: KeepSignedInSite) {
      const others = (await currentKeep()).filter(kept => kept.site !== entry.site);
      if (others.length >= KEEP_SIGNED_IN_MAX_SITES) return settleKeep(`Keep signed in holds at most ${KEEP_SIGNED_IN_MAX_SITES} sites.`);
      return saveKeep([...others, entry]);
    },
    async onRemoveKeep(site: string) {
      return saveKeep((await currentKeep()).filter(kept => kept.site !== site));
    },
    // D-347 follow-up 22 — what a form's own check found, kept so the next redraw shows it too.
    async onBlockedProblem(problem: string) {
      return settle(problem);
    },
    async onKeepProblem(problem: string) {
      return settleKeep(problem);
    },
  };
};
