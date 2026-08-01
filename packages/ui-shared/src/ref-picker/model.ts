/** Shared ref-picker — pure UI state machine.
 *
 *  No DOM. Every transition takes a state + returns a fresh state, so the
 *  whole behaviour (typing, async results, keyboard nav, commit, clear,
 *  blur-revert) is exercised in plain node tests. `wire.ts` is a thin DOM
 *  shell over these.
 */

import type {
  RefPickerOption,
  RefPickerSelection,
  RefPickerState,
} from './types.js';

/** Seed state. A pre-selected value lands as both the committed
 *  selection AND the input text, so the field opens showing the name. */
export const initialRefPickerState = (
  initial?: RefPickerSelection | null,
): RefPickerState => ({
  query: initial?.label ?? '',
  open: false,
  activeIndex: -1,
  options: [],
  truncated: false,
  loading: false,
  error: null,
  selectedId: initial?.id ?? null,
  selectedLabel: initial?.label ?? null,
});

/** User typed. Always opens the list; resets the highlight (the result
 *  set is about to change). The committed selection is left untouched —
 *  it only changes on `commitOption`/`clearSelection`, so a stray
 *  keystroke never silently drops the field's value. */
export const setQuery = (
  state: RefPickerState,
  query: string,
): RefPickerState => ({
  ...state,
  query,
  open: true,
  activeIndex: -1,
  // The next query owns the next result set. Keeping the previous options
  // around would let Enter select an invisible stale row while loading.
  options: [],
  truncated: false,
  // Typing past a committed label makes the list relevant again; a search
  // is about to run, so reflect that immediately (no flicker between the
  // keystroke and the async resolve).
  loading: true,
  error: null,
});

/** Async results landed (or a synchronous client-filter produced them).
 *  Clears loading; preserves the highlight when it still points at a row,
 *  else drops it to -1. */
export const setResults = (
  state: RefPickerState,
  options: readonly RefPickerOption[],
  truncated = false,
): RefPickerState => ({
  ...state,
  options,
  truncated,
  loading: false,
  error: null,
  activeIndex: state.activeIndex < options.length ? state.activeIndex : -1,
});

/** Toggle the in-flight flag (the focus path opens + searches without a
 *  preceding `setQuery`, so it marks loading here). */
export const setLoading = (
  state: RefPickerState,
  loading: boolean,
): RefPickerState =>
  state.loading === loading ? state : { ...state, loading };

/** A search failed. The dropdown surfaces `message`; the previous options
 *  are cleared so a stale list can't be picked. */
export const setError = (
  state: RefPickerState,
  message: string,
): RefPickerState => ({
  ...state,
  options: [],
  truncated: false,
  loading: false,
  error: message,
  activeIndex: -1,
});

/** Open the list without changing the query (focus / arrow-from-closed). */
export const openList = (state: RefPickerState): RefPickerState =>
  state.open ? state : { ...state, open: true };

/** Close the list. Leaves the query alone — callers that want the input
 *  text reverted to the committed label pair this with `revertQuery`. */
export const closeList = (state: RefPickerState): RefPickerState =>
  !state.open && state.activeIndex === -1
    ? state
    : { ...state, open: false, activeIndex: -1 };

/** Snap the input text back to the committed label (blur / escape without
 *  a pick), so what's shown always matches what's stored. */
export const revertQuery = (state: RefPickerState): RefPickerState => {
  const reverted = state.selectedLabel ?? '';
  return state.query === reverted ? state : { ...state, query: reverted };
};

/** Move the highlight by `delta`. From closed it opens + highlights the
 *  first row. Clamps within `[0, options.length - 1]`; an empty list
 *  leaves the highlight at -1. */
export const moveActive = (
  state: RefPickerState,
  delta: number,
): RefPickerState => {
  if (state.options.length === 0) {
    return state.open ? state : { ...state, open: true };
  }
  if (!state.open) {
    return { ...state, open: true, activeIndex: 0 };
  }
  const base = state.activeIndex < 0 ? (delta > 0 ? -1 : 0) : state.activeIndex;
  const next = clamp(base + delta, 0, state.options.length - 1);
  return next === state.activeIndex ? state : { ...state, activeIndex: next };
};

/** Commit a pick. The query becomes the label (so the input shows the
 *  name), the selection is stored, and the list closes. */
export const commitOption = (
  state: RefPickerState,
  option: RefPickerOption,
): RefPickerState => ({
  ...state,
  query: option.label,
  open: false,
  activeIndex: -1,
  selectedId: option.id,
  selectedLabel: option.label,
});

/** Clear the field entirely (the × affordance, or an empty-on-blur). */
export const clearSelection = (state: RefPickerState): RefPickerState => ({
  ...state,
  query: '',
  open: false,
  activeIndex: -1,
  options: [],
  truncated: false,
  loading: false,
  error: null,
  selectedId: null,
  selectedLabel: null,
});

/** The currently-highlighted option, or null. */
export const activeOption = (state: RefPickerState): RefPickerOption | null =>
  state.activeIndex >= 0 && state.activeIndex < state.options.length
    ? state.options[state.activeIndex]!
    : null;

/** The option Enter should pick: the highlighted row, else the top match
 *  (so Enter on a typed query commits the obvious result without an
 *  explicit arrow-down). Null when the list is empty. */
export const enterTarget = (state: RefPickerState): RefPickerOption | null =>
  activeOption(state) ?? state.options[0] ?? null;

/** The default client-side filter for in-memory inventories (recipes,
 *  loaded lists). Case-insensitive substring over label, then sublabel,
 *  then id; label matches rank above sublabel/id matches; an empty query
 *  returns the head of the list. Stable + total-order so results don't
 *  jitter between keystrokes. */
export const filterRefOptions = (
  options: readonly RefPickerOption[],
  query: string,
  limit = 50,
): RefPickerOption[] => {
  const q = query.trim().toLowerCase();
  if (q === '') return options.slice(0, limit);
  const scored: Array<{ option: RefPickerOption; rank: number; index: number }> =
    [];
  options.forEach((option, index) => {
    const rank = matchRank(option, q);
    if (rank >= 0) scored.push({ option, rank, index });
  });
  scored.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  return scored.slice(0, limit).map((s) => s.option);
};

/** Lower is better; -1 = no match. label-prefix < label-substring <
 *  sublabel/id-substring. */
const matchRank = (option: RefPickerOption, q: string): number => {
  const label = option.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  const sub = option.sublabel?.toLowerCase() ?? '';
  if (sub.includes(q)) return 2;
  if (option.id.toLowerCase().includes(q)) return 3;
  return -1;
};

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;
