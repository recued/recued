import { createPromptBulkControls, type PromptBulkClient } from './prompt-bulk-controls.js';
import type { PromptSearchState } from './prompt-search.js';
import { SEARCH_PROMPT_BULK_SLOT, SEARCH_PROMPT_SELECT_SLOT } from './prompt-search-view.js';

export const SEARCH_PROMPT_BULK_FOCUS = 'data-prompt-focus';
const focusKey = (key: string) => key.includes('bulk:') ? key : 'bulk:' + key;

/** Mount the existing reviewed controls into Search's rendered slots.
 * Selection follows the search scope; attempted requests retain their receipts. */
export const createPromptSearchBulk = (deps: {
  document: Document;
  call?: PromptBulkClient;
  state: () => PromptSearchState;
  active: () => boolean;
  blocked: () => boolean;
  opening: () => void;
  render: () => void;
  refresh: () => Promise<void>;
}) => {
  let writing = false, disposed = false;
  let pending = Promise.resolve();
  let focus: { key: string; from?: string } | undefined;
  const ready = () => deps.state().loaded && !deps.state().loading && !deps.state().error && !deps.state().unsupported;
  const controls = deps.call ? createPromptBulkControls({
    document: deps.document, call: deps.call, storagePrefix: 'recued:search-prompt-bulk:',
    selectionLabel: count => `Select loaded matching prompts (${count})`,
    busy: () => writing || deps.blocked() || !deps.active() || deps.state().loading, applying: () => writing,
    opening: deps.opening,
    redraw: key => {
      if (disposed) return;
      if (key) focus = { key: focusKey(key), ...(writing ? { from: 'bulk:results' } : {}) };
      deps.render();
    },
    mutate: work => {
      if (writing || disposed || deps.blocked() || !deps.active() || deps.state().loading) return pending;
      writing = true; focus = { key: 'bulk:results' }; deps.render();
      pending = (async () => {
        try { await work(); if (!disposed) await deps.refresh(); }
        finally { writing = false; if (!disposed) deps.render(); }
      })();
      return pending;
    },
  }) : undefined;
  return {
    writing: () => writing,
    whenSettled: () => pending,
    resetSelection: () => { if (!writing) { controls?.resetSelection(); focus = undefined; } },
    mount: (root: HTMLElement): void => {
      if (disposed || !controls || !deps.active()) return;
      const slot = root.querySelector<HTMLElement>(`[${SEARCH_PROMPT_BULK_SLOT}]`);
      if (!slot) return;
      const state = deps.state(), toolbar = controls.renderToolbar(state.rows, ready() ? state.matches : []);
      if (toolbar) {
        const scope = deps.document.createElement('p'); scope.className = 'rq-subtle';
        scope.textContent = 'Selection covers loaded results only. Review the exact prompts and timing before applying.';
        toolbar.prepend(scope); slot.replaceChildren(toolbar);
      }
      if (ready()) for (const target of Array.from(root.querySelectorAll<HTMLElement>(`[${SEARCH_PROMPT_SELECT_SLOT}]`))) {
        const row = state.matches.find(row => row.schedule_id === target.getAttribute(SEARCH_PROMPT_SELECT_SLOT));
        const checkbox = row && controls.checkbox(row);
        if (checkbox) target.replaceChildren(checkbox);
      }
    },
    restoreFocus: (root: HTMLElement, previous: string | null | undefined): void => {
      const request = focus; focus = undefined;
      if (disposed || !deps.active()) return;
      const owned = request && (!request.from || request.from === previous), key = owned ? request.key : previous;
      if (!key) return;
      const elements = Array.from(root.querySelectorAll<HTMLElement>(`.rq-search [${SEARCH_PROMPT_BULK_FOCUS}]`));
      const target = elements.find(el => el.getAttribute(SEARCH_PROMPT_BULK_FOCUS) === key);
      (target && !target.hasAttribute('disabled') ? target : root.querySelector<HTMLElement>('#rq-search-input'))
        ?.focus({ preventScroll: !owned || key === previous });
    },
    dispose: () => { disposed = true; controls?.dispose(); focus = undefined; },
  };
};
