/** Shared name→id reference-picker (combobox) — types.
 *
 *  ONE inventory-agnostic primitive that replaces the raw-id text inputs
 *  scattered across the webclient (recipe filters, `data.*` ref fields,
 *  reception destinations, approval ids). The user types a NAME, sees
 *  matching suggestions, and the picker stores the resolved ID.
 *
 *  Three layers, separable for testability:
 *   - `model.ts` — a pure UI state machine (query / open / active index /
 *                  results / committed selection). No DOM. Node-testable.
 *   - `render.ts` — pure HTML-string renderers (the shell + the results
 *                  sublist on its own, for surgical keystroke repaints).
 *   - `wire.ts`  — `wireRefPicker`, the DOM-light glue: ATTACHES to the
 *                  shell the host already rendered (it never parses its
 *                  own innerHTML into existence), wires listeners, and
 *                  repaints ONLY the dropdown on each keystroke so the
 *                  host never re-paints the input → focus is preserved.
 *                  `rewire()` re-attaches from JS state after a host
 *                  re-paint blew the previous subtree away.
 *
 *  The host supplies a `RefPickerSearchCaller` over whatever inventory
 *  backs the field (contacts → `contact.list`; recipes → `recipe.list`
 *  filtered client-side; …); the picker is otherwise inventory-agnostic.
 */

/** One selectable suggestion: a human `label` shown in the list + the
 *  `id` actually stored on selection. `sublabel` is an optional second
 *  line (an email, a publisher, a record kind) for disambiguation. */
export interface RefPickerOption {
  id: string;
  label: string;
  sublabel?: string;
}

/** A committed selection — what `getValue()` returns and `onChange`
 *  reports. `null` everywhere means "no selection / cleared". */
export interface RefPickerSelection {
  id: string;
  label: string;
}

/** Resolve a query string to ranked suggestions. Async by construction
 *  so a server-backed inventory (contacts) and an in-memory one (the
 *  loaded recipe list) share one shape — the latter just resolves
 *  immediately. Implementations should tolerate an empty query (return
 *  the top-N or an empty list); `wire.ts` decides whether to call based
 *  on `minChars`. */
/** What a search returns. A bare array is the whole answer. The object form
 *  lets a host say the answer is INCOMPLETE — it read a capped page and the
 *  query may match something it never saw.
 *
 *  ⛔ This exists because "no match" and "no match in the first 50 rows I
 *  happened to read" are the same screen otherwise, and the user acts on the
 *  first reading. A picker that quietly cannot see a record is worse than one
 *  that admits it, because the missing record looks like a missing FACT. */
export interface RefPickerSearchPage {
  readonly options: readonly RefPickerOption[];
  /** The underlying read hit its page cap, so matches may be missing. */
  readonly truncated?: boolean;
}

export type RefPickerSearchCaller = (
  query: string,
) => Promise<readonly RefPickerOption[] | RefPickerSearchPage>;

/** Normalize either search-result shape to the object form. */
export const asRefPickerSearchPage = (
  result: readonly RefPickerOption[] | RefPickerSearchPage,
): RefPickerSearchPage =>
  Array.isArray(result) ? { options: result } : (result as RefPickerSearchPage);

/** The pure UI state. Held by `wire.ts` in JS (so it survives a host
 *  re-paint) and consumed by the renderers. */
export interface RefPickerState {
  /** The live text in the input. Diverges from `selectedLabel` while the
   *  user is typing a fresh query; reverts to it on blur/escape. */
  query: string;
  /** Whether the suggestion list is shown. */
  open: boolean;
  /** Highlighted option index, or -1 for none. Clamped to `options`. */
  activeIndex: number;
  /** The suggestions currently shown (already filtered/ranked). */
  options: readonly RefPickerOption[];
  /** A search is in flight (async inventories). */
  loading: boolean;
  /** Last search error, surfaced inline in the dropdown. */
  error: string | null;
  /** The committed id, or null when empty. */
  selectedId: string | null;
  /** The committed label (display text), or null when empty. */
  selectedLabel: string | null;
  /** The last search read a capped page — shown as a trailing status row so
   *  an absent match reads as "not found HERE", not "does not exist". */
  truncated: boolean;
}

/** Static config the renderers need — stable across the picker's life. */
export interface RefPickerRenderConfig {
  /** Overrides the sentence shown when a search read a capped page. */
  truncatedText?: string;
  /** Unique-per-picker marker. The shell carries `data-ref-picker=<id>`;
   *  `wire.ts` finds its subtree by it. */
  pickerId: string;
  /** Input placeholder text. */
  placeholder?: string;
  /** Accessible name for the input (the picker renders no `<label for>`,
   *  so set this when the visible caption isn't programmatically tied). */
  ariaLabel?: string;
  /** Shown when a (non-loading) search yields nothing. Default
   *  "No matches." */
  emptyText?: string;
  /** Shown while a search is in flight. Default "Searching…". */
  loadingText?: string;
  /** When set, the shell ALSO emits a hidden `<input data-form-field=…
   *  data-form-type="ref">` carrying the selected id, so the
   *  form-renderer's `readFormValues` reads it back unchanged. Omitted
   *  for route filters that read the value via `getValue()`/`onChange`. */
  formFieldName?: string;
  /** Array-item variant of the mirror: emits a hidden `<input
   *  data-form-array-item=… data-form-array-index=… data-form-type="ref">`
   *  instead of the `data-form-field` form, so the form-renderer's ARRAY
   *  reader — which walks `data-form-array-item` per index — reads this
   *  item's id back. Used for `array<ref>` fields (note/project related
   *  contacts). Mutually exclusive with `formFieldName`; `formFieldName`
   *  takes precedence if both are somehow set. */
  arrayMirror?: { field: string; index: number };
}

/** Options for `wireRefPicker`. */
export interface WireRefPickerOptions {
  /** Inventory lookup. */
  search: RefPickerSearchCaller;
  /** Fired on every committed selection change (a pick, or a clear). */
  onChange?: (selection: RefPickerSelection | null) => void;
  /** Pre-selected value (a deep-link, a stored id). */
  initialValue?: RefPickerSelection | null;
  /** Render config — the renderers reuse it on every surgical repaint. */
  config: RefPickerRenderConfig;
  /** Minimum query length before `search` fires. Default 1; pass 0 to
   *  surface the whole (small, client-side) inventory on focus. */
  minChars?: number;
  /** Debounce window (ms) for `search`. Default 160. */
  debounceMs?: number;
  /** Injectable deferred scheduler for the debounce — tests pass a
   *  synchronous runner; production defaults to `setTimeout`. Returns a
   *  canceller. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** Imperative handle returned by `wireRefPicker`. */
export interface RefPickerHandle {
  /** Current committed selection, or null when empty. */
  getValue(): RefPickerSelection | null;
  /** Current visible query text. Primarily useful for safe async label
   *  hydration: a late resolver must not overwrite text the user has typed. */
  getQuery(): string;
  /** Programmatically set (or clear, with null) the selection. Repaints
   *  the picker's subtree; does NOT fire `onChange`. */
  setValue(selection: RefPickerSelection | null): void;
  /** Re-attach to a freshly-painted host. Call after the host overwrote
   *  the container's innerHTML — the previous subtree + its listeners are
   *  gone, but the JS state survives, so this repaints from state and
   *  re-wires. Idempotent; a no-op when the shell is absent. */
  rewire(root: ParentNode): void;
  /** Remove listeners + cancel any pending search. The host owns the
   *  container's DOM lifecycle. Idempotent. */
  destroy(): void;
}
