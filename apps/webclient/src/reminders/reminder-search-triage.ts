import type { ReminderView } from '@recued/contracts';
import { createReminderTriage, type ReminderTriageCallers } from './reminder-triage.js';
import type { ReminderSearchTriageView } from './reminder-search-view.js';

export const SEARCH_TRIAGE_ACTION = 'universal-reminders-triage-';
export const SEARCH_TRIAGE_FIELD = 'data-search-reminder-triage-field';
export const SEARCH_TRIAGE_FOCUS = 'data-search-reminder-triage-focus';

/** Search owns its selection and focus independently of the Reminders tab.
 * The shared triage controller owns review tokens, writes, and safe retries. */
export const createReminderSearchTriage = (deps: {
  callers: ReminderTriageCallers;
  rows: () => readonly ReminderView[];
  active: () => boolean;
  ready: () => boolean;
  zone: () => string;
  now: () => number;
  actionAttr: string;
  render: () => void;
  refresh: () => Promise<void>;
}) => {
  let pendingFocus: { key: string; from?: readonly string[] } | null = null;
  const triage = createReminderTriage({
    ...deps, rows: () => deps.ready() ? deps.rows() : [],
    actionPrefix: SEARCH_TRIAGE_ACTION, fieldAttr: SEARCH_TRIAGE_FIELD, focusAttr: SEARCH_TRIAGE_FOCUS,
    focus: (key, from) => { pendingFocus = { key, from }; },
    beforeStart: deps.active, beforeWrite: () => {}, onResult: () => {},
  });
  return {
    ...triage,
    view: (): ReminderSearchTriageView => ({
      html: triage.render(), writing: triage.writing(),
      selection: row => deps.ready() ? triage.renderSelection(row) : '',
    }),
    reset: () => { triage.reset(); pendingFocus = null; },
    restoreFocus: (root: HTMLElement, previous: string | null | undefined): void => {
      const request = pendingFocus; pendingFocus = null;
      if (!deps.active()) return;
      const owned = request && (!request.from || !!previous && request.from.includes(previous));
      const key = owned ? request.key : previous;
      if (!key) return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(`[${SEARCH_TRIAGE_FOCUS}]`));
      const control = controls.find(el => el.getAttribute(SEARCH_TRIAGE_FOCUS) === key)
        ?? controls.find(el => el.getAttribute(SEARCH_TRIAGE_FOCUS) === 'triage-status');
      control?.focus({ preventScroll: !owned || key === previous });
    },
  };
};
