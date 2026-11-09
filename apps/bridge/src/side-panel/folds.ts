/** 2026-11-04 — the side panel's foldable sections.
 *
 *  The owner: "the bridge panel is full of all the data and approval has to scroll all the way
 *  down. perhaps move approval up and allow each sections to be foldable". So approvals lead the
 *  panel, unfolded, and every other section folds to one line: its title and what it holds now
 *  ("2 running", "Connected · 26.11.4"). A section starts open only where something needs the
 *  owner or is happening now; once the owner opens or closes one, that choice is kept, in this
 *  browser only (`localStorage`, as a per-viewer convenience: an unreadable store starts every
 *  section at its default).
 *
 *  Pure DOM, like `views.ts`: no `chrome.*`, so the mount tests drive it on a fake document. */

import type { SidePanelStoreState } from './store/local-store.js';
import { BRIDGE_STATUS_CONNECTING, formatRelative, SIDE_PANEL_SECTION_ATTR, type SectionId } from './views.js';

/** The sections that fold. Approvals never do, and the diagnostic keeps its own fold. */
export type FoldableSectionId = Exclude<SectionId, 'approvals' | 'bridge-diagnostic'>;

export const FOLDABLE_SECTION_IDS: readonly FoldableSectionId[] = [
  'active-executions', 'notifications', 'recipe-results', 'watch', 'sites', 'server-status',
];

/** A folded section's title, in the owner's words. */
export const FOLD_TITLES: Readonly<Record<FoldableSectionId, string>> = {
  'active-executions': 'Running now',
  notifications: 'Notifications',
  'recipe-results': 'Recent runs',
  watch: 'Watch a page element',
  sites: 'Sites',
  'server-status': 'Server',
};

/** Marks a folded section's `<details>`, by the section's id. */
export const SIDE_PANEL_FOLD_ATTR = 'data-recued-side-panel-fold';

/** Where the owner's choices are kept. */
export const SIDE_PANEL_FOLDS_STORAGE_KEY = 'recued.bridge.side_panel.folds';

/** The owner's open-or-closed choice for each section, once made. */
export interface SidePanelFolds {
  get(id: FoldableSectionId): boolean | undefined;
  set(id: FoldableSectionId, open: boolean): void;
}

/** Choices kept in `storage` when one is given (the panel's `localStorage`), else for this panel
 *  only. A store that cannot be read or written costs the memory, never the panel. */
export const createSidePanelFolds = (
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): SidePanelFolds => {
  const saved = new Map<FoldableSectionId, boolean>();
  try {
    const raw = storage?.getItem(SIDE_PANEL_FOLDS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const id of FOLDABLE_SECTION_IDS) {
        const value = (parsed as Record<string, unknown>)[id];
        if (typeof value === 'boolean') saved.set(id, value);
      }
    }
  } catch {
    // An unreadable store: every section starts at its default.
  }
  return {
    get: (id) => saved.get(id),
    set: (id, open) => {
      saved.set(id, open);
      try {
        storage?.setItem(SIDE_PANEL_FOLDS_STORAGE_KEY, JSON.stringify(Object.fromEntries(saved)));
      } catch {
        // Kept for this panel only.
      }
    },
  };
};

/** Whether the server's state needs the owner: it cannot be reached, it is offline, its keyfile
 *  is not sealed (D-212 §7.10: an operator may run unsealed, never without knowing), or a
 *  disconnect is under way or did not go through. */
const serverNeedsOwner = (state: SidePanelStoreState): boolean => {
  const { status, error } = state.status;
  return (status === null && error !== null && error !== BRIDGE_STATUS_CONNECTING)
    || status?.ws_state === 'offline'
    || status?.keyfile_sealing === 'none'
    || state.disconnect.phase !== 'idle'
    || state.disconnect.message !== '';
};

/** Whether a section starts open when the owner has not chosen: where something is happening
 *  now, or something needs them. */
export const foldOpenByDefault = (id: FoldableSectionId, state: SidePanelStoreState): boolean => {
  switch (id) {
    case 'active-executions': return state.active.entries.length > 0 || state.active.notice !== '';
    case 'notifications':
      return state.bridge_mode.notification && state.desktop_notifications === 'denied';
    case 'recipe-results': return false;
    case 'watch': return state.element_watch.message !== '';
    case 'sites': return state.sites.every_site === false || state.sites.message !== '';
    case 'server-status': return serverNeedsOwner(state);
  }
};

export interface FoldSummary {
  readonly text: string;
  /** `danger` for a line that says something is wrong. */
  readonly tone: 'muted' | 'danger';
}

const muted = (text: string): FoldSummary => ({ text, tone: 'muted' });
const danger = (text: string): FoldSummary => ({ text, tone: 'danger' });

/** The line a folded section shows beside its title: what it holds now. */
export const foldSummary = (id: FoldableSectionId, state: SidePanelStoreState, now: number): FoldSummary => {
  switch (id) {
    case 'active-executions': {
      if (state.active.error !== null && state.active.entries.length === 0) return danger('Could not load');
      const running = state.active.entries.filter((entry) => entry.state === 'running').length;
      const waiting = state.active.entries.length - running;
      if (running === 0 && waiting === 0) return muted(state.active.fetched_at === null ? 'Loading…' : 'Nothing running');
      return muted([running > 0 ? `${running} running` : '', waiting > 0 ? `${waiting} waiting` : '']
        .filter((part) => part !== '').join(' · '));
    }
    case 'notifications': {
      if (!state.bridge_mode.notification) return muted('Off for this bridge');
      if (state.desktop_notifications === 'denied') return danger('Chrome has them turned off');
      if (state.notifications.error !== null) return danger('Could not load');
      const items = state.notifications.items;
      if (items.length === 0) return muted(state.notifications.fetched_at === null ? 'Loading…' : 'None yet');
      const latest = Math.max(...items.map((item) => item.fired_at));
      return muted(`${items.length} · latest ${formatRelative(latest, now)}`);
    }
    case 'recipe-results': {
      if (state.recipe_results.error !== null) return danger('Could not load');
      const items = state.recipe_results.items;
      if (items.length === 0) return muted(state.recipe_results.fetched_at === null ? 'Loading…' : 'None yet');
      const failed = items.filter((item) => item.status === 'error').length;
      return failed > 0 ? danger(`${items.length} · ${failed} failed`) : muted(`${items.length}`);
    }
    case 'watch':
      return state.element_watch.message !== ''
        ? (state.element_watch.tone === 'danger' ? danger : muted)(state.element_watch.message)
        : muted('Be told when it changes');
    case 'sites': {
      const { every_site, blocked, screenshots } = state.sites;
      if (state.sites.message !== '') return danger(state.sites.message);
      if (every_site === false) return danger('Not allowed on every site');
      const parts = [every_site === null ? 'Checking…' : 'Every site'];
      if (blocked.length > 0) parts.push(`${blocked.length} never used`);
      if (screenshots === true) parts.push('screenshots on');
      return muted(parts.join(' · '));
    }
    case 'server-status': {
      const { status, error } = state.status;
      if (state.disconnect.phase === 'working') return muted('Disconnecting…');
      if (status === null) {
        if (error === null || error === BRIDGE_STATUS_CONNECTING) return muted('Connecting…');
        return danger('Cannot reach your server');
      }
      const problems = [
        status.ws_state === 'offline' ? 'Offline' : '',
        status.keyfile_sealing === 'none' ? 'keyfile not sealed' : '',
      ].filter((problem) => problem !== '');
      if (problems.length > 0) {
        const line = problems.join(' · ');
        return danger(`${line.charAt(0).toUpperCase()}${line.slice(1)}`);
      }
      return muted(`Connected · ${status.version}`);
    }
  }
};

export interface FoldOptions {
  readonly id: FoldableSectionId;
  readonly open: boolean;
  readonly summary: FoldSummary;
  /** The owner opened or closed it. Not called for the fold's own first state. */
  readonly onToggle?: (open: boolean) => void;
}

/** Fold a rendered section: its heading becomes the fold's summary line (title and what it holds),
 *  and the rest of it the fold's body. The section keeps its own attributes, so everything that
 *  finds a section by `SIDE_PANEL_SECTION_ATTR` still does. */
export const foldSection = (doc: Document, section: HTMLElement, fold: FoldOptions): HTMLElement => {
  const content: HTMLElement[] = [];
  while (section.firstChild) {
    const child = section.firstChild as HTMLElement;
    section.removeChild(child);
    if (child.tagName !== 'H2') content.push(child);
  }
  section.className = 'fold-section';

  const details = doc.createElement('details') as HTMLDetailsElement;
  details.className = 'fold';
  details.setAttribute(SIDE_PANEL_FOLD_ATTR, fold.id);
  details.open = fold.open;
  const summary = doc.createElement('summary');
  summary.className = 'fold-summary';
  const title = doc.createElement('span');
  title.className = 'fold-title';
  title.textContent = FOLD_TITLES[fold.id];
  const meta = doc.createElement('span');
  meta.className = fold.summary.tone === 'danger' ? 'fold-meta fold-meta-danger' : 'fold-meta';
  meta.textContent = fold.summary.text;
  summary.appendChild(title);
  summary.appendChild(meta);
  details.appendChild(summary);
  const body = doc.createElement('div');
  body.className = 'fold-body';
  for (const child of content) body.appendChild(child);
  details.appendChild(body);
  section.appendChild(details);

  // A `<details>` reports its first state as a toggle too; only the owner's own count.
  let shown = fold.open;
  details.addEventListener('toggle', () => {
    const open = details.open === true;
    if (open === shown) return;
    shown = open;
    fold.onToggle?.(open);
  });
  return section;
};

/** The "Watch this element" block as a section of its own, so it folds as the others do. */
export const watchSection = (doc: Document, cta: HTMLElement): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(SIDE_PANEL_SECTION_ATTR, 'watch' satisfies SectionId);
  section.appendChild(cta);
  return section;
};
