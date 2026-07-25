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
}
interface EventLike {
  target?: unknown;
  key?: string;
  preventDefault?: () => void;
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
    }
    if (shellEl !== null) {
      shellEl.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    }
    if (inputEl !== null) {
      if ((inputEl.value ?? '') !== state.query) inputEl.value = state.query;
      if (state.open && state.activeIndex >= 0) {
        inputEl.setAttribute(
          'aria-activedescendant',
          refPickerOptionDomId(config.pickerId, state.activeIndex),
        );
      } else {
        inputEl.removeAttribute('aria-activedescendant');
      }
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
      state = setResults(state, []);
      paint();
      return;
    }
    state = setLoading(state, true);
    const fire = (): void => {
      Promise.resolve(opts.search(value)).then(
        (options) => {
          if (destroyed || seq !== searchSeq) return;
          state = setResults(state, options);
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
        state = revertQuery(closeList(state));
        paint();
        return;
      default:
    }
  };

  // Selection runs on mousedown (NOT click) with preventDefault, so the
  // input never blurs first — the canonical fix for the
  // option-click-vs-blur race.
  const onMousedown = (event: EventLike): void => {
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
    if (closestWithAttr(event.target, REF_PICKER_CLEAR_ATTR, shellEl) !== null) {
      prevent(event);
      doClear();
    }
  };

  const onFocusin = (event: EventLike): void => {
    if (!isInput(event.target)) return;
    hadFocus = true;
    state = openList(state);
    paint();
    runSearch((inputEl?.value as string | undefined) ?? '', true);
  };

  // A genuine blur (tab away / click elsewhere) closes + reverts the input
  // text to the committed label. Option/clear mousedown keep focus, so
  // this doesn't fire from clicking inside the picker.
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
    bind(shellEl, 'mousedown', onMousedown);
    bind(shellEl, 'focusin', onFocusin);
    bind(shellEl, 'focusout', onFocusout);
    // Reconcile the freshly-rendered (resting) shell with our live state.
    paint();
    if (hadFocus && inputEl !== null && typeof inputEl.focus === 'function') {
      inputEl.focus();
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
    setValue: (selection: RefPickerSelection | null) => {
      state =
        selection === null
          ? clearSelection(state)
          : commitOption(state, { id: selection.id, label: selection.label });
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
