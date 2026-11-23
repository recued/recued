/** D-402 slice F4d (§7.9, rulings 4 and 12) — what your chats and AI apps may do with a recipe without
 *  asking, and ending it, on three of the owner's pages:
 *  - **Contracts:** every recipe your chats or an AI app run without asking;
 *  - **a recipe's page:** who runs that recipe without asking (`only.recipe_id`);
 *  - **an AI app's contract page:** each recipe that app runs without asking (`only.contract_id`),
 *    with **End all**.
 *
 *  One card per caller and recipe: the "Always" the owner gave from the question before a run (or a
 *  run's "Yes, this time" while that run lasts), by its caller's name, how often it was used, and why
 *  one covers nothing now. **End it** asks once more, then ends EVERYTHING that caller may do with that
 *  recipe without asking (`collection.contract.stopAllowing`, ruling 12): its pre-approvals, site
 *  passes, "Allow in this chat", delegations and rules. The panel then says what it ended.
 *  **End all** does that for each recipe on the page, one after the other.
 *
 *  The rpc family is `collection.contract.*`, which MCP never reaches: an AI app gives up its own
 *  through an op of its own. A server from before these answers `unknown_method`, and the panel and its
 *  host are hidden. With nothing to list it hides its host too, unless it has just said what it ended. */

import {
  stopAllowingSummary,
  type CallerPreapprovalView,
  type PreapprovalCaller,
  type StopAllowingResult,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export interface CallerPreapprovalPanelCallers {
  readonly list: () => Promise<{ preapprovals: ReadonlyArray<CallerPreapprovalView> }>;
  readonly stopAllowing: (args: { caller: PreapprovalCaller; recipe_id: string }) => Promise<{ ended: StopAllowingResult }>;
}

export interface CallerPreapprovalPanelMount {
  /** The panel's own element: a host that redraws its page re-attaches it rather than mounting again. */
  readonly root: HTMLElement;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  /** Whether an end is in flight: its host keeps it mounted until it settles. */
  pending(): boolean;
  dispose(): void;
}

/** D-402 slice F5 — the kinds the panel reads again on. The server fans only the kinds a client names,
 *  so the panel's test pins these in `WEBCLIENT_DEFAULT_SUBSCRIPTIONS`; the panel subscribes off this list. */
export const CALLER_PREAPPROVAL_PANEL_BROADCAST_KINDS = ['contract.preapproval_changed'] as const;
/** How long a burst of changes (a run's writes each spend a use) waits, to be read once. */
export const CALLER_PREAPPROVAL_LIVE_REFRESH_MS = 250;

export const CALLER_PREAPPROVAL_PANEL_ATTR = 'data-recued-caller-preapproval-panel';
export const CALLER_PREAPPROVAL_PANEL_ROW_ATTR = 'data-recued-caller-preapproval-row';
export const CALLER_PREAPPROVAL_PANEL_END_ATTR = 'data-recued-caller-preapproval-end';
export const CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR = 'data-recued-caller-preapproval-confirm';
export const CALLER_PREAPPROVAL_PANEL_CANCEL_ATTR = 'data-recued-caller-preapproval-cancel';
export const CALLER_PREAPPROVAL_PANEL_END_ALL_ATTR = 'data-recued-caller-preapproval-end-all';
export const CALLER_PREAPPROVAL_PANEL_NOTE_ATTR = 'data-recued-caller-preapproval-note';
export const CALLER_PREAPPROVAL_PANEL_ERROR_ATTR = 'data-recued-caller-preapproval-error';

/** The cards' key for a caller and a recipe. */
export const callerPreapprovalGroupKey = (caller: PreapprovalCaller, recipe_id: string): string =>
  `${caller.kind === 'owner_chat' ? 'owner_chat' : `ai_app:${caller.contract_id}`}|${recipe_id}`;

/** One caller's rows for one recipe: what one "End it" ends. */
interface Group {
  readonly key: string;
  readonly caller: PreapprovalCaller;
  readonly caller_name: string;
  readonly recipe_id: string;
  readonly recipe_name: string;
  readonly rows: ReadonlyArray<CallerPreapprovalView>;
}

/** "Your chats", "Claude Desktop": who holds it, to start a line. */
const capitalized = (name: string): string => (name === '' ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`);

/** "Your chats run it without asking", "Claude Desktop runs it without asking". */
const runsLine = (group: Group): string =>
  `${capitalized(group.caller_name)} ${group.caller.kind === 'owner_chat' ? 'run' : 'runs'} it without asking`;

/** What is left of it, or why it covers nothing now. A standing one outranks a one-run one, and either
 *  outranks one for an earlier version of the recipe. */
const termsLine = (group: Group): string => {
  const live = group.rows.filter((row) => row.state === 'live');
  const standing = live.filter((row) => row.run_id === undefined);
  if (standing.length > 0) {
    const uses = standing.reduce((sum, row) => sum + row.uses, 0);
    return `Every time, until you end it${uses > 0 ? ` · used ${String(uses)} ${uses === 1 ? 'time' : 'times'}` : ''}`;
  }
  if (live.length > 0) return 'This run only: it ends with the run';
  return 'Not in use: the recipe changed since, so it asks again';
};

const ownerWords = (error: unknown): string => humanizeRpcError(error).replace(/^collection\.contract\.\w+: /u, '');

export const mountCallerPreapprovalPanel = (options: {
  readonly host: HTMLElement;
  readonly callers: CallerPreapprovalPanelCallers;
  /** Only this recipe's cards (a recipe's page), or only this AI app's (its contract page). */
  readonly only?: { readonly recipe_id?: string; readonly contract_id?: string };
  /** An AI app's page: **End all**, once there are two cards or more. */
  readonly endAll?: boolean;
  readonly heading?: string;
  /** The heading's level on its page (default 3). */
  readonly headingLevel?: 2 | 3;
  /** The page's own class for its section titles, in place of the panel's. */
  readonly headingClassName?: string;
  readonly intro?: string;
  /** Told after each end that ended something, so its page can refresh what else it shows. */
  readonly onEnded?: (ended: StopAllowingResult) => void;
  /** D-402 slice F5 — live updates: a caller's pre-approval granted, used or ended anywhere (another
   *  device, a run, the chat) reads the list again. */
  readonly subscribe?: BroadcastSubscriber['on'];
  readonly document?: Document;
}): CallerPreapprovalPanelMount => {
  const { host, callers, only } = options;
  const doc = options.document ?? host.ownerDocument;
  const root = doc.createElement('div');
  root.setAttribute(CALLER_PREAPPROVAL_PANEL_ATTR, '');
  // Focus waits here while a repaint has no control to put it on (Chromium drops it to <body>).
  root.tabIndex = -1;
  host.appendChild(root);

  let groups: ReadonlyArray<Group> | undefined;
  let listError: string | null = null;
  let actionError: { id: string; message: string } | null = null;
  let note: string | null = null;
  let confirming: string | null = null;
  let busy: string | null = null;
  let disposed = false;
  let generation = 0;
  let loading: Promise<void> = Promise.resolve();
  const focusables = new Map<string, HTMLElement>();
  let focusNext: string | null = null;
  // D-402 slice F5 — read again once for a burst; an end in flight reads again when it settles.
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const stopListening = (options.subscribe === undefined ? [] : CALLER_PREAPPROVAL_PANEL_BROADCAST_KINDS.map((kind) =>
    options.subscribe!(kind, (event) => {
      if (event.holder !== 'caller' || disposed || liveTimer !== undefined) return;
      liveTimer = setTimeout(() => {
        liveTimer = undefined;
        if (!disposed && busy === null) void refresh();
      }, CALLER_PREAPPROVAL_LIVE_REFRESH_MS);
    })));
  const stopLive = (): void => {
    for (const stop of stopListening.splice(0)) stop();
    if (liveTimer !== undefined) clearTimeout(liveTimer);
    liveTimer = undefined;
  };

  const el = (tag: string, className?: string, text?: string): HTMLElement => {
    const node = doc.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  /** While an end runs, every control says it is unavailable and does nothing: by `aria-disabled`, so
   *  the one the owner pressed keeps focus. */
  const button = (key: string, attr: string, value: string, className: string, label: string, onClick: () => void): HTMLButtonElement => {
    const node = el('button', className, label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute(attr, value);
    if (busy !== null) node.setAttribute('aria-disabled', 'true');
    node.addEventListener('click', () => { if (busy === null) onClick(); });
    focusables.set(key, node);
    return node;
  };
  const working = (node: HTMLButtonElement): HTMLButtonElement => {
    node.textContent = 'Working…';
    node.setAttribute('aria-busy', 'true');
    return node;
  };
  const errorLine = (id: string): HTMLElement | null => {
    if (actionError === null || actionError.id !== id) return null;
    const line = el('p', 'cpa-error', actionError.message);
    line.setAttribute('role', 'alert');
    line.setAttribute(CALLER_PREAPPROVAL_PANEL_ERROR_ATTR, '');
    return line;
  };

  /** End each group, one after the other: what they ended in all, and the first refusal. */
  const end = async (id: string, ending: ReadonlyArray<Group>): Promise<void> => {
    if (busy !== null) return;
    busy = id;
    actionError = null;
    note = null;
    focusNext = `confirm:${id}`;
    render();
    const total = { preapprovals: 0, site_passes: 0, session_grants: 0, delegations: 0, write_rules: 0 };
    let failed: string | null = null;
    for (const group of ending) {
      try {
        const { ended } = await callers.stopAllowing({ caller: group.caller, recipe_id: group.recipe_id });
        total.preapprovals += ended.preapprovals;
        total.site_passes += ended.site_passes;
        total.session_grants += ended.session_grants;
        total.delegations += ended.delegations;
        total.write_rules += ended.write_rules;
      } catch (error) {
        failed ??= ownerWords(error);
      }
    }
    busy = null;
    confirming = failed === null ? null : confirming;
    if (disposed) return;
    const summary = stopAllowingSummary(total);
    if (summary !== '') {
      note = `Ended ${summary}. ${ending.length === 1 ? 'It asks' : 'They ask'} again from now on.`;
      options.onEnded?.(total);
    } else if (failed === null) {
      note = 'Nothing was left to end.';
    }
    if (failed !== null) actionError = { id, message: `Recued could not end ${ending.length === 1 ? 'it' : 'them all'}: ${failed}` };
    focusNext = failed !== null ? `confirm:${id}` : `end:${id}`;
    await refresh();
  };

  const renderGroup = (group: Group): HTMLElement => {
    const card = el('div', 'cpa-row');
    card.setAttribute(CALLER_PREAPPROVAL_PANEL_ROW_ATTR, group.key);
    const info = el('div', 'cpa-info');
    // A recipe's page names who; the others name the recipe, and who on the next line.
    if (only?.recipe_id !== undefined) {
      info.appendChild(el('div', 'cpa-heading', capitalized(group.caller_name)));
    } else {
      info.appendChild(el('div', 'cpa-heading', group.recipe_name));
      if (only?.contract_id === undefined) info.appendChild(el('div', 'cpa-terms', runsLine(group)));
    }
    info.appendChild(el('div', 'cpa-terms', termsLine(group)));
    card.appendChild(info);
    const actions = el('div', 'cpa-actions');
    if (confirming === group.key) {
      actions.appendChild(el('span', 'cpa-confirm-prompt', 'It asks again from now on.'));
      const confirm = button(`confirm:${group.key}`, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, group.key, 'cpa-danger', 'End it', () => {
        void end(group.key, [group]);
      });
      actions.appendChild(busy === group.key ? working(confirm) : confirm);
      actions.appendChild(button(`cancel:${group.key}`, CALLER_PREAPPROVAL_PANEL_CANCEL_ATTR, group.key, 'cpa-secondary', 'Cancel', () => {
        confirming = null;
        focusNext = `end:${group.key}`;
        render();
      }));
    } else {
      actions.appendChild(button(`end:${group.key}`, CALLER_PREAPPROVAL_PANEL_END_ATTR, group.key, 'cpa-secondary', 'End it', () => {
        confirming = group.key;
        actionError = null;
        focusNext = `confirm:${group.key}`;
        render();
      }));
    }
    card.appendChild(actions);
    const error = errorLine(group.key);
    if (error !== null) card.appendChild(error);
    return card;
  };

  const ALL = 'all';
  const renderEndAll = (all: ReadonlyArray<Group>): HTMLElement => {
    const actions = el('div', 'cpa-actions');
    if (confirming === ALL) {
      actions.appendChild(el('span', 'cpa-confirm-prompt', 'Each of these asks again from now on.'));
      const confirm = button(`confirm:${ALL}`, CALLER_PREAPPROVAL_PANEL_CONFIRM_ATTR, ALL, 'cpa-danger', 'End all', () => {
        void end(ALL, all);
      });
      actions.appendChild(busy === ALL ? working(confirm) : confirm);
      actions.appendChild(button(`cancel:${ALL}`, CALLER_PREAPPROVAL_PANEL_CANCEL_ATTR, ALL, 'cpa-secondary', 'Cancel', () => {
        confirming = null;
        focusNext = `end:${ALL}`;
        render();
      }));
    } else {
      actions.appendChild(button(`end:${ALL}`, CALLER_PREAPPROVAL_PANEL_END_ALL_ATTR, ALL, 'cpa-secondary', 'End all', () => {
        confirming = ALL;
        actionError = null;
        focusNext = `confirm:${ALL}`;
        render();
      }));
    }
    const error = errorLine(ALL);
    if (error !== null) actions.appendChild(error);
    return actions;
  };

  function render(): void {
    if (disposed) return;
    const active = doc.activeElement;
    const ours = active === null || active === undefined || active === doc.body || root.contains?.(active) === true;
    focusables.clear();
    while (root.firstChild) root.removeChild(root.firstChild);
    paint();
    if (focusNext === null) return;
    const key = focusNext;
    focusNext = null;
    if (ours) (focusables.get(key) ?? root).focus?.({ preventScroll: true });
  }

  function paint(): void {
    const shown = groups ?? [];
    // Nothing to list (yet), nothing just said: the section stays out of the way. Most recipes have
    // nothing here, so a page never flashes "Loading…" for it.
    host.hidden = listError === null && actionError === null && note === null && shown.length === 0;
    if (host.hidden) return;
    if (options.heading !== undefined) {
      root.appendChild(el(`h${String(options.headingLevel ?? 3)}`, options.headingClassName ?? 'cpa-title', options.heading));
    }
    if (options.intro !== undefined && shown.length > 0) root.appendChild(el('p', 'cpa-copy', options.intro));
    if (listError !== null) {
      const line = el('p', 'cpa-error', `Recued could not load what runs without asking: ${listError}`);
      line.setAttribute('role', 'alert');
      line.setAttribute(CALLER_PREAPPROVAL_PANEL_ERROR_ATTR, '');
      root.appendChild(line);
    }
    if (note !== null) {
      const line = el('p', 'cpa-note', note);
      line.setAttribute('role', 'status');
      line.setAttribute(CALLER_PREAPPROVAL_PANEL_NOTE_ATTR, '');
      root.appendChild(line);
    }
    for (const group of shown) root.appendChild(renderGroup(group));
    if (options.endAll === true && shown.length >= 2) root.appendChild(renderEndAll(shown));
    else if (actionError?.id === ALL) {
      const error = errorLine(ALL);
      if (error !== null) root.appendChild(error);
    }
  }

  /** The rows still in force, or for an earlier version (they say so), as one card per caller and recipe:
   *  newest first, as the server lists them. */
  const grouped = (rows: ReadonlyArray<CallerPreapprovalView>): Group[] => {
    const byKey = new Map<string, Group>();
    for (const row of rows) {
      if (row.state === 'revoked') continue;
      if (only?.recipe_id !== undefined && row.recipe_id !== only.recipe_id) continue;
      if (only?.contract_id !== undefined && (row.caller.kind !== 'ai_app' || row.caller.contract_id !== only.contract_id)) continue;
      const key = callerPreapprovalGroupKey(row.caller, row.recipe_id);
      const known = byKey.get(key);
      byKey.set(key, known === undefined
        ? { key, caller: row.caller, caller_name: row.caller_name, recipe_id: row.recipe_id, recipe_name: row.recipe_name, rows: [row] }
        : { ...known, rows: [...known.rows, row] });
    }
    return [...byKey.values()];
  };

  const refresh = (): Promise<void> => {
    const mine = (generation += 1);
    loading = (async () => {
      try {
        const { preapprovals } = await callers.list();
        if (disposed || mine !== generation) return;
        groups = grouped(preapprovals);
        listError = null;
        // A card that is gone cannot be confirmed.
        if (confirming !== null && confirming !== ALL && !groups.some((group) => group.key === confirming)) confirming = null;
      } catch (error) {
        if (disposed || mine !== generation) return;
        // A server from before these: the section goes, rather than saying it could not load.
        if (groups === undefined && classifyRpcError(error).code === 'unknown_method') {
          host.hidden = true;
          root.remove();
          disposed = true;
          stopLive();
          return;
        }
        listError = ownerWords(error);
      }
      render();
    })();
    return loading;
  };

  render();
  void refresh();

  return {
    root,
    refresh,
    whenLoaded: () => loading,
    pending: () => busy !== null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopLive();
      try { root.remove(); } catch { /* a detached root */ }
    },
  };
};

/** Self-scoped CSS, joined into each host route's one `<style>` bundle. ⚠ A host can style bare
 *  elements, so each rule here says what it needs rather than inheriting it. */
export const CALLER_PREAPPROVAL_PANEL_STYLES = `
[${CALLER_PREAPPROVAL_PANEL_ATTR}] { display: grid; gap: 8px; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-title { margin: 0; font-size: 15px; font-weight: 650; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-copy { margin: 0; font-size: 13px; color: var(--muted); line-height: 1.45; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-note { margin: 0; font-size: 13px; color: var(--fg); line-height: 1.45; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-row {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
}
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-heading { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-terms { font-size: 12px; color: var(--muted); margin: 0; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-confirm-prompt { font-size: 12px; color: var(--fail); }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-error { font-size: 13px; color: var(--fail); margin: 0; flex-basis: 100%; }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-secondary,
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-danger {
  font-size: 13px; padding: 4px 12px; border-radius: 6px; background: var(--surface); cursor: pointer; white-space: nowrap;
  min-height: 32px;
}
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-secondary { border: 1px solid var(--border); color: var(--fg); }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-danger { border: 1px solid var(--fail); color: var(--fail); }
[${CALLER_PREAPPROVAL_PANEL_ATTR}] button[aria-disabled="true"] { opacity: 0.6; cursor: default; }
@media (pointer: coarse) {
  [${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-secondary, [${CALLER_PREAPPROVAL_PANEL_ATTR}] .cpa-danger { min-height: 44px; }
}
`;
