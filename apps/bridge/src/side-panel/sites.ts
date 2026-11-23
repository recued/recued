/** D-335 slice G — what the side panel's Sites section does: Chrome's grant of
 *  every site, and the owner's list of sites Recued must never use
 *  (`permissions/site-grants.ts`). Over injected `chrome.permissions` and
 *  `chrome.storage.local`, so it is tested without a browser;
 *  `side-panel-entry.ts` binds it. */

import {
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
import type { SidePanelKeepRow, SidePanelRemovedSite, SidePanelSitesState } from './store/local-store.js';
import { createSiteListMutator, type SiteListEdit, type SiteListMutator, type SiteListMutationResult } from '../site-list-mutations.js';
import {
  SIDE_PANEL_KEEP_REMOVE_ATTR,
  SIDE_PANEL_KEEP_UNDO_ATTR,
  SIDE_PANEL_SITES_REMOVE_ATTR,
  SIDE_PANEL_SITES_UNDO_ATTR,
  type SitesHandlers,
} from './views.js';

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
const NOT_READ = 'Could not read the list. Nothing changed. Try again.';
const LIST_UNREADABLE = 'Your list of sites could not be read, so the Bridge acts on no page until it is. '
  + 'Adding or removing a site saves it again.';

/** The Sites section's handlers, and `refresh`, which reads both from Chrome
 *  and hands them to `apply`. Call it on open and on each change Chrome
 *  reports. Native panels supply the runtime mutator; the local default is
 *  for callers already sharing the worker's module queue. */
export const createSitesControls = (
  chrome: SitesChrome,
  apply: (sites: SidePanelSitesState) => void,
  mutate: SiteListMutator = createSiteListMutator(chrome.storage),
): Required<SitesHandlers> & { refresh(): Promise<void> } => {
  /** Why the last change did not go through; '' when it did. */
  let message = '';
  /** D-347 follow-up 22 — the same for Keep signed in, said in its own card. */
  let keepMessage = '';
  /** D-347 follow-up 30 — each list's last removal, while its Undo can put the site back where it stood: until it
   *  does, or another site is added to or removed from that list. Kept here, so a redraw keeps the offer, and only
   *  while the panel is open. */
  let removedBlocked: SidePanelRemovedSite | undefined;
  let removedKeep: { entry: KeepSignedInSite; index: number } | undefined;
  /** Follow-up 30 — the control to focus once the next state is drawn; given with that one state. */
  let focusNext: { attr: string; value: string } | undefined;
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
      note = message === NOT_READ ? NOT_READ : LIST_UNREADABLE;
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
      // Follow-up 30 — an offer to undo, while its site is not listed again; the focus, with this state only.
      const removed = removedBlocked !== undefined && !blocked.includes(removedBlocked.site) ? { ...removedBlocked } : undefined;
      const keepRemoved = removedKeep !== undefined && !keep.some((row) => row.entry.site === removedKeep!.entry.site)
        ? { site: removedKeep.entry.site, index: removedKeep.index } : undefined;
      const focus = focusNext;
      focusNext = undefined;
      apply({ every_site, screenshots, blocked, message: note, keep, ...(keepMessage !== '' ? { keep_message: keepMessage } : {}),
        ...(removed !== undefined ? { removed } : {}), ...(keepRemoved !== undefined ? { keep_removed: keepRemoved } : {}),
        ...(focus !== undefined ? { focus } : {}) });
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
  // Keep this panel's reply handling and Undo offers in gesture order. The
  // worker separately serializes storage mutations across every panel and expiry.
  let edits: Promise<void> = Promise.resolve();
  const runEdit = (work: () => Promise<void>): Promise<void> => {
    const result = edits.then(work);
    edits = result.catch(() => undefined);
    return result;
  };
  const change = async (edit: SiteListEdit): Promise<Extract<SiteListMutationResult, { ok: true }> | null> => {
    let result: SiteListMutationResult;
    try { result = await mutate(edit); }
    catch { result = { ok: false, error: 'unconfirmed' }; }
    if (result.ok) return result;
    const note = result.error === 'read_failed' ? NOT_READ : result.error === 'save_failed' ? NOT_SAVED
      : result.error === 'full' ? edit.list === 'blocked' ? `The list holds at most ${BLOCKED_SITES_MAX} sites.`
        : `Keep signed in holds at most ${KEEP_SIGNED_IN_MAX_SITES} sites.`
        : 'Could not confirm the change. Refresh the list before trying again.';
    await (edit.list === 'blocked' ? settle(note) : settleKeep(note));
    return null;
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
    onAddBlocked: site => runEdit(async () => {
      const result = await change({ list: 'blocked', op: 'add', site });
      if (!result) return;
      if (result.written) removedBlocked = undefined;
      await settle('');
    }),
    onRemoveBlocked: site => runEdit(async () => {
      const result = await change({ list: 'blocked', op: 'remove', site });
      if (!result) return;
      if (result.removed) {
        removedBlocked = { site: result.removed.site, index: result.removed.index };
        focusNext = { attr: SIDE_PANEL_SITES_UNDO_ATTR, value: site };
      }
      await settle('');
    }),
    onUndoRemoveBlocked() {
      const undo = removedBlocked;
      return runEdit(async () => {
        if (undo === undefined) return refresh();
        const result = await change({ list: 'blocked', op: 'restore', site: undo.site, index: undo.index });
        if (!result) return;
        if (removedBlocked === undo) removedBlocked = undefined;
        if (result.written) focusNext = { attr: SIDE_PANEL_SITES_REMOVE_ATTR, value: undo.site };
        await settle('');
      });
    },
    // D-347 follow-up 19 — a site added again takes the settings it is added with.
    onAddKeep: (entry: KeepSignedInSite) => runEdit(async () => {
      const result = await change({ list: 'keep', op: 'add', entry });
      if (!result) return;
      removedKeep = undefined;
      await settleKeep('');
    }),
    onRemoveKeep: site => runEdit(async () => {
      const result = await change({ list: 'keep', op: 'remove', site });
      if (!result) return;
      if (result.removed?.entry) {
        removedKeep = { entry: result.removed.entry, index: result.removed.index };
        focusNext = { attr: SIDE_PANEL_KEEP_UNDO_ATTR, value: site };
      }
      await settleKeep('');
    }),
    // Follow-up 30 — put back as it was, settings, hours and all: the timer then keeps it as before. What the Bridge
    // remembered of its tabs (when the owner signed in, the run of refreshes) is not: removing it let them go.
    onUndoRemoveKeep() {
      const undo = removedKeep;
      return runEdit(async () => {
        if (undo === undefined) return refresh();
        const result = await change({ list: 'keep', op: 'restore', entry: undo.entry, index: undo.index });
        if (!result) return;
        if (removedKeep === undo) removedKeep = undefined;
        if (result.written) focusNext = { attr: SIDE_PANEL_KEEP_REMOVE_ATTR, value: undo.entry.site };
        await settleKeep('');
      });
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
