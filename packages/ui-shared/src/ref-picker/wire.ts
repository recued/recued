/** Shared ref-picker — DOM glue (`wireRefPicker`).
 *
 *  ATTACH-based: the host renders the shell (via `renderRefPicker`) inside
 *  its own markup; this function finds that shell and wires it. It never
 *  builds the shell from its own innerHTML, so it stays testable against a
 *  string-only fake DOM (the surgical repaint targets the pre-existing
 *  `<ul>` results node, which the host — or a test — has already created).
 *
 *  State lives in this closure (NOT in the DOM), so it survives a host
 *  re-paint: after the host overwrites its container's innerHTML, call
 *  `handle.rewire(root)` and the picker re-attaches + repaints from state
 *  (restoring an open dropdown / in-progress query / focus).
 *
 *  Keystrokes repaint ONLY the results `<ul>` body, leaving the input
 *  element untouched → focus + caret are preserved while typing.
 */

import {
  clearSelection,
  closeList,
  commitOption,
  enterTarget,
  initialRefPickerState,
  moveActive,
  openList,
  revertQuery,
  setError,
  setLoading,
  setQuery,
  setResults,
} from './model.js';
import {
  REF_PICKER_CLEAR_ATTR,
  REF_PICKER_INPUT_ATTR,
  REF_PICKER_OPTION_INDEX_ATTR,
  REF_PICKER_RESULTS_ATTR,
  REF_PICKER_VALUE_ATTR,
  refPickerOptionDomId,
  renderRefPickerResultRows,
} from './render.js';
import { asRefPickerSearchPage } from './types.js';
import type {
  RefPickerHandle,
  RefPickerSelection,
  RefPickerState,
  WireRefPickerOptions,
} from './types.js';

/** Minimal structural views — we duck-type so the production DOM and the
 *  fake-DOM test harness both compose without pulling in lib.dom. */
interface ElementLike {
  value?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): ElementLike | null;
  addEventListener(type: string, fn: (event: EventLike) => void): void;
  removeEventListener(type: string, fn: (event: EventLike) => void): void;
  parentElement?: ElementLike | null;
  innerHTML?: string;
  focus?: () => void;
  scrollIntoView?: (options?: { block?: 'nearest' }) => void;
}
interface EventLike {
  target?: unknown;
  key?: string;
  isComposing?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export const wireRefPicker = (
  root: ParentNode,
  opts: WireRefPickerOptions,
): RefPickerHandle => {
  const { config } = opts;
  const minChars = opts.minChars ?? 1;
  const debounceMs = opts.debounceMs ?? 160;
  const schedule = opts.schedule ?? defaultSchedule;

  let state: RefPickerState = initialRefPickerState(opts.initialValue);
  let shellEl: ElementLike | null = null;
  let inputEl: ElementLike | null = null;
  let resultsEl: ElementLike | null = null;
  let clearEl: ElementLike | null = null;
  // The hidden `data-form-field` / `data-form-array-item` mirror (present
  // only when the picker backs a form-renderer `ref` field). `readFormValues`
  // reads the committed id off THIS element, not the visible input — so a
  // commit/clear must write the id through here or the form reads a stale id.
  let mirrorEl: ElementLike | null = null;
  let hadFocus = false;
  let restoringFocus = false;
  let destroyed = false;
  let searchSeq = 0;
  let cancelDebounce: (() => void) | null = null;
  const bound: Array<[ElementLike, string, (event: EventLike) => void]> = [];

  // ── DOM patch ──────────────────────────────────────────────────────
  // Surgical: only the results `<ul>` body + a handful of attributes are
  // touched. The input element is left alone unless its value genuinely
  // drifted from state (commit / clear / revert), so typing never moves
  // the caret.
  const paint = (): void => {
    if (resultsEl !== null) {
      if (resultsEl.innerHTML !== undefined) {
        resultsEl.innerHTML = state.open
          ? renderRefPickerResultRows(state, config)
          : '';
      }
      setBoolAttr(resultsEl, 'hidden', !state.open);
      resultsEl.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    }
    if (inputEl !== null) {
      if ((inputEl.value ?? '') !== state.query) inputEl.value = state.query;
      inputEl.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      inputEl.setAttribute('aria-busy', state.loading ? 'true' : 'false');
      if (state.open && state.activeIndex >= 0) {
        inputEl.setAttribute(
          'aria-activedescendant',
          refPickerOptionDomId(config.pickerId, state.activeIndex),
        );
      } else {
        inputEl.removeAttribute('aria-activedescendant');
      }
    }
    if (state.open && state.activeIndex >= 0 && resultsEl !== null) {
      resultsEl.querySelector(
        `[${REF_PICKER_OPTION_INDEX_ATTR}="${state.activeIndex}"]`,
      )?.scrollIntoView?.({ block: 'nearest' });
    }
    if (clearEl !== null) {
      setBoolAttr(clearEl, 'hidden', state.selectedId === null);
    }
    if (mirrorEl !== null && mirrorEl.value !== undefined) {
      const next = state.selectedId ?? '';
      if (mirrorEl.value !== next) mirrorEl.value = next;
    }
  };

  // ── search ─────────────────────────────────────────────────────────
  const runSearch = (value: string, immediate: boolean): void => {
    cancelDebounce?.();
    cancelDebounce = null;
    // Bump the invalidation token NOW (not inside `fire`), so a newer
    // query — or a clear below `minChars` — drops any OLDER in-flight
    // result even while this newer one is still waiting out its debounce.
    const seq = ++searchSeq;
    if (value.trim().length < minChars) {
      state = closeList(setResults(state, []));
      paint();
      return;
    }
    state = setLoading(state, true);
    paint();
    const fire = (): void => {
      let pending: ReturnType<typeof opts.search>;
      try {
        pending = opts.search(value);
      } catch (err: unknown) {
        if (!destroyed && seq === searchSeq) {
          state = setError(state, errorMessage(err));
          paint();
        }
        return;
      }
      Promise.resolve(pending).then(
        (result) => {
          if (destroyed || seq !== searchSeq) return;
          const page = asRefPickerSearchPage(result);
          state = setResults(state, page.options, page.truncated === true);
          paint();
        },
        (err: unknown) => {
          if (destroyed || seq !== searchSeq) return;
          state = setError(state, errorMessage(err));
          paint();
        },
      );
    };
    if (immediate) {
      fire();
    } else {
      cancelDebounce = schedule(fire, debounceMs);
    }
  };

  // ── commit helpers ─────────────────────────────────────────────────
  const select = (optionIndex: number): void => {
    const option = state.options[optionIndex];
    if (option === undefined) return;
    state = commitOption(state, option);
    paint();
    opts.onChange?.({ id: option.id, label: option.label });
  };
  const doClear = (): void => {
    cancelDebounce?.();
    cancelDebounce = null;
    searchSeq += 1;
    state = clearSelection(state);
    paint();
    opts.onChange?.(null);
  };

  // ── event handlers ─────────────────────────────────────────────────
  const onInput = (event: EventLike): void => {
    if (!isInput(event.target)) return;
    const value = (inputEl?.value as string | undefined) ?? '';
    state = setQuery(state, value);
    paint();
    runSearch(value, false);
  };

  const onKeydown = (event: EventLike): void => {
    if (!isInput(event.target)) return;
    // IMEs use Enter, Escape, and the arrow keys to navigate and commit their
    // own candidate list. The picker must not move or select underneath that
    // composition; the next non-composing keydown can operate normally.
    if (event.isComposing === true) return;
    switch (event.key) {
      case 'ArrowDown':
        prevent(event);
        state = moveActive(state, 1);
        paint();
        return;
      case 'ArrowUp':
        prevent(event);
        state = moveActive(state, -1);
        paint();
        return;
      case 'Enter': {
        if (!state.open) return;
        const target = enterTarget(state);
        if (target === null) return;
        prevent(event);
        select(state.options.indexOf(target));
        return;
      }
      case 'Escape':
        if (!state.open) return;
        prevent(event);
        // A combobox consumes the first Escape to dismiss its popup. Without
        // this, the same bubbling keydown also closes a containing modal or
        // config editor, turning a local cancel into a destructive exit.
        event.stopPropagation?.();
        state = revertQuery(closeList(state));
        paint();
        return;
      default:
    }
  };

  // Option selection runs on pointerdown (mousedown on older/test DOMs), with
  // preventDefault, so the input never blurs first — the canonical fix for
  // the option-click-vs-blur race. Pointer events also cover touch + pen.
  const onPress = (event: EventLike): void => {
    const optionEl = closestWithAttr(
      event.target,
      REF_PICKER_OPTION_INDEX_ATTR,
      shellEl,
    );
    if (optionEl !== null) {
      prevent(event);
      const raw = optionEl.getAttribute(REF_PICKER_OPTION_INDEX_ATTR);
      const index = raw === null ? NaN : Number(raw);
      if (Number.isInteger(index)) select(index);
      return;
    }
  };

  const onClick = (event: EventLike): void => {
    if (closestWithAttr(event.target, REF_PICKER_CLEAR_ATTR, shellEl) === null) {
      return;
    }
    prevent(event);
    doClear();
    inputEl?.focus?.();
  };

  const onFocusin = (event: EventLike): void => {
    if (!isInput(event.target)) return;
    hadFocus = true;
    // A host repaint can replace the focused input immediately after a
    // selection. Rewire restores that focus, but the synthetic focus-in must
    // not reopen the list that the commit just closed. A genuinely new user
    // focus still opens and searches as usual.
    if (restoringFocus) return;
    state = openList(state);
    paint();
    const value = (inputEl?.value as string | undefined) ?? '';
    // Re-opening a committed picker should show the inventory, not search its
    // display label and usually return only itself. Empty-query inventories opt
    // into this with minChars=0; other pickers preserve their threshold.
    const query = minChars === 0
      && state.selectedId !== null
      && value === state.selectedLabel
        ? ''
        : value;
    runSearch(query, true);
  };

  // A genuine blur (tab away / click elsewhere) closes + reverts the input
  // text to the committed label. Option pointerdown keeps focus. The clear
  // button may take focus normally, then its click clears and returns focus —
  // important on touch, where cancelling pointerdown can suppress click.
  const onFocusout = (): void => {
    hadFocus = false;
    state = revertQuery(closeList(state));
    paint();
  };

  // ── attach / detach ────────────────────────────────────────────────
  const detach = (): void => {
    for (const [el, type, fn] of bound) el.removeEventListener(type, fn);
    bound.length = 0;
  };

  const attach = (searchRoot: ParentNode): void => {
    detach();
    const queryable = searchRoot as unknown as ElementLike;
    // Degrade gracefully on a root that can't be queried (a minimal-DOM
    // test host, or a surface that string-renders its innerHTML): the
    // picker simply doesn't mount rather than throwing.
    if (typeof queryable.querySelector !== 'function') {
      shellEl = inputEl = resultsEl = clearEl = mirrorEl = null;
      return;
    }
    shellEl = queryable.querySelector(`[data-ref-picker="${config.pickerId}"]`);
    if (shellEl === null) {
      inputEl = resultsEl = clearEl = mirrorEl = null;
      return;
    }
    inputEl = shellEl.querySelector(`[${REF_PICKER_INPUT_ATTR}]`);
    resultsEl = shellEl.querySelector(`[${REF_PICKER_RESULTS_ATTR}]`);
    clearEl = shellEl.querySelector(`[${REF_PICKER_CLEAR_ATTR}]`);
    mirrorEl = shellEl.querySelector(`[${REF_PICKER_VALUE_ATTR}]`);
    bind(shellEl, 'input', onInput);
    bind(shellEl, 'keydown', onKeydown);
    const pointerEventsAvailable =
      typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'function';
    bind(shellEl, pointerEventsAvailable ? 'pointerdown' : 'mousedown', onPress);
    bind(shellEl, 'click', onClick);
    bind(shellEl, 'focusin', onFocusin);
    bind(shellEl, 'focusout', onFocusout);
    // Reconcile the freshly-rendered (resting) shell with our live state.
    paint();
    if (hadFocus && inputEl !== null && typeof inputEl.focus === 'function') {
      restoringFocus = true;
      try {
        inputEl.focus();
      } finally {
        restoringFocus = false;
      }
    }
  };

  const bind = (
    el: ElementLike,
    type: string,
    fn: (event: EventLike) => void,
  ): void => {
    el.addEventListener(type, fn);
    bound.push([el, type, fn]);
  };

  const isInput = (target: unknown): boolean =>
    target === inputEl ||
    (isElementLike(target) &&
      target.getAttribute(REF_PICKER_INPUT_ATTR) !== null);

  attach(root);

  return {
    getValue: () =>
      state.selectedId !== null
        ? { id: state.selectedId, label: state.selectedLabel ?? '' }
        : null,
    getQuery: () => state.query,
    setQuery: (query: string) => {
      if (destroyed) return;
      state = setQuery(state, query);
      paint();
      runSearch(query, true);
    },
    setValue: (selection: RefPickerSelection | null) => {
      if (destroyed) return;
      if (selection === null) {
        state = clearSelection(state);
      } else if (selection.id === state.selectedId) {
        // Label hydration is not a new choice. Preserve an open inventory,
        // highlight, and in-flight search; update the visible text only while
        // it still shows the prior committed label (never clobber typing).
        const priorLabel = state.selectedLabel ?? '';
        state = {
          ...state,
          selectedLabel: selection.label,
          query: state.query === priorLabel ? selection.label : state.query,
        };
      } else {
        state = commitOption(state, { id: selection.id, label: selection.label });
      }
      paint();
    },
    rewire: (nextRoot: ParentNode) => {
      if (destroyed) return;
      attach(nextRoot);
    },
    destroy: () => {
      destroyed = true;
      cancelDebounce?.();
      cancelDebounce = null;
      detach();
      shellEl = inputEl = resultsEl = clearEl = mirrorEl = null;
    },
  };
};

// ── helpers ──────────────────────────────────────────────────────────

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

const prevent = (event: EventLike): void => {
  if (typeof event.preventDefault === 'function') event.preventDefault();
};

const setBoolAttr = (el: ElementLike, name: string, on: boolean): void => {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
};

/** Walk up from `target` (inclusive) to `boundary` (inclusive), returning
 *  the first element carrying `attr`. */
const closestWithAttr = (
  target: unknown,
  attr: string,
  boundary: ElementLike | null,
): ElementLike | null => {
  let cur = isElementLike(target) ? target : null;
  while (cur !== null) {
    if (cur.getAttribute(attr) !== null) return cur;
    if (cur === boundary) break;
    cur = cur.parentElement ?? null;
  }
  return null;
};

const isElementLike = (value: unknown): value is ElementLike =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { getAttribute?: unknown }).getAttribute === 'function';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
