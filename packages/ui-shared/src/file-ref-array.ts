/** D-215 slice 5 residual — the ORDERED `file_ref[]` picker.
 *
 *  The singular `file_ref` row is one combobox holding one id. This is a
 *  LIST: an append box over the same owner-file inventory, plus per-row
 *  reorder / remove controls. Ordering is part of the value — a carousel's
 *  images publish in the order chosen, `pdfunite` merges in the order given —
 *  so this preserves SELECTION order, never inventory order, and duplicates
 *  are kept rather than folded away (a sequence, not a set).
 *
 *  Two layers, matching the ref-picker's split:
 *   - the pure list ops below (`appendFileRef` / `moveFileRef` /
 *     `removeFileRef`) — no DOM, node-testable, and where every ordering rule
 *     actually lives;
 *   - `wireFileRefArray`, DOM-light glue that ATTACHES to the shell
 *     `renderVariableWidget` already painted. It repaints ONLY the `<ol>`
 *     body on each mutation, so the append combobox (a sibling, outside the
 *     list) keeps its focus, its caret, and its listeners.
 *
 *  The `<li>` rows are the committed value: `readWidgetValue` walks them in
 *  DOM order. This closure's `items` is the same list plus display labels,
 *  and `onChange` reports the ids after every mutation.
 */

import {
  FILE_REF_ARRAY_ACTION_ATTR,
  FILE_REF_ARRAY_INDEX_ATTR,
  FILE_REF_ARRAY_LIST_ATTR,
  FILE_REF_ARRAY_VARIABLE_ATTR,
  fileRefArrayItem,
  fileRefArrayVariablePickerId,
  renderFileRefArrayItems,
  type FileRefArrayItem,
} from './variable-widgets.js';
import {
  wireRefPicker,
  type RefPickerHandle,
  asRefPickerSearchPage,
  type RefPickerSearchCaller,
} from './ref-picker/index.js';

/** CSS for the ordered list. Unscoped `var-file-refs-*` classes, injected by
 *  each host alongside `REF_PICKER_STYLES` — the same pattern, for the same
 *  reason: two hosts render this row and neither owns the widget. */
export const FILE_REF_ARRAY_STYLES = `
.var-file-refs {
  display: grid;
  gap: 4px;
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
}

.var-file-refs-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: var(--color-input-bg, var(--surface));
  font-size: 0.82rem;
}

.var-file-refs-item--missing {
  border-color: var(--color-warning, var(--danger));
  color: var(--color-warning, var(--danger));
}

.var-file-refs-pos {
  flex: none;
  min-width: 1.2em;
  text-align: right;
  color: var(--color-text-secondary, var(--fg-muted));
  font-variant-numeric: tabular-nums;
}

.var-file-refs-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-file-refs-btn {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--color-border, var(--border));
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.var-file-refs-btn:hover:not([disabled]) {
  background: var(--color-chip-bg, var(--surface-sunk));
}

.var-file-refs-btn[disabled] {
  opacity: 0.35;
  cursor: default;
}

.var-file-refs-empty {
  padding: 4px 0;
  font-size: 0.78rem;
  color: var(--color-text-secondary, var(--fg-muted));
}
`;

// ────────────────────────────────────────────────────────────────
// Pure list ops — every ordering rule, no DOM
// ────────────────────────────────────────────────────────────────

/** Append a pick to the end. Duplicates are ALLOWED: the value is a
 *  sequence, and a carousel may legitimately repeat an image. Silently
 *  refusing a pick would be the surprising behaviour. */
export const appendFileRef = (
  items: readonly FileRefArrayItem[],
  item: FileRefArrayItem,
): FileRefArrayItem[] => [...items, item];

/** Move the item at `index` by `delta`. Out-of-range indices and moves that
 *  would fall off either end return the list UNCHANGED — the disabled
 *  first-`↑` / last-`↓` buttons are an affordance, not the guard. */
export const moveFileRef = (
  items: readonly FileRefArrayItem[],
  index: number,
  delta: number,
): FileRefArrayItem[] => {
  const target = index + delta;
  if (
    !Number.isInteger(index)
    || index < 0
    || index >= items.length
    || target < 0
    || target >= items.length
  ) return [...items];
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
};

/** Drop the item at `index`. An out-of-range index is a no-op. */
export const removeFileRef = (
  items: readonly FileRefArrayItem[],
  index: number,
): FileRefArrayItem[] =>
  !Number.isInteger(index) || index < 0 || index >= items.length
    ? [...items]
    : items.filter((_, i) => i !== index);

/** The committed value — ids in order, labels dropped. */
export const fileRefArrayIds = (
  items: readonly FileRefArrayItem[],
): string[] => items.map((item) => item.id);

// ────────────────────────────────────────────────────────────────
// DOM glue
// ────────────────────────────────────────────────────────────────

export interface WireFileRefArrayOptions {
  /** The recipe variable this row edits. */
  key: string;
  /** Human label, for the append box's accessible name. */
  label: string;
  /** Must match the `idPrefix` the row was rendered with, or the append
   *  combobox is not found and the row stays read-only. */
  idPrefix: string;
  /** Owner-file inventory — the same caller the singular picker uses. */
  search: RefPickerSearchCaller;
  /** Stored ids, in order. Labels resolve asynchronously. */
  initialIds: readonly string[];
  /** Fired after EVERY mutation with the ordered ids. The host persists. */
  onChange: (ids: string[]) => void;
}

export interface FileRefArrayHandle {
  /** Current ordered ids. */
  getValue(): string[];
  /** Remove listeners + tear down the append picker. Idempotent. */
  destroy(): void;
}

/** Minimal structural views — duck-typed so the production DOM and a
 *  fake-DOM test harness both compose without pulling in lib.dom. */
interface ElementLike {
  getAttribute(name: string): string | null;
  querySelector(selector: string): ElementLike | null;
  addEventListener(type: string, fn: (event: EventLike) => void): void;
  removeEventListener(type: string, fn: (event: EventLike) => void): void;
  parentElement?: ElementLike | null;
  innerHTML?: string;
  focus?: () => void;
}
interface EventLike {
  target?: unknown;
  preventDefault?: () => void;
}

/** Attach to the `file_ref[]` row for `key` under `root`.
 *
 *  Returns `null` when the row is absent — a host whose surface string-rendered
 *  its markup (or never emitted the picker variant) simply doesn't mount,
 *  rather than throwing. */
export const wireFileRefArray = (
  root: ParentNode,
  opts: WireFileRefArrayOptions,
): FileRefArrayHandle | null => {
  const queryable = root as unknown as ElementLike;
  if (typeof queryable.querySelector !== 'function') return null;
  const rowEl = queryable.querySelector(
    `[${FILE_REF_ARRAY_VARIABLE_ATTR}="${opts.key}"]`,
  );
  if (rowEl === null) return null;
  const listEl = rowEl.querySelector(`[${FILE_REF_ARRAY_LIST_ATTR}]`);
  if (listEl === null) return null;

  let items: FileRefArrayItem[] = opts.initialIds.map((id) => ({ id, label: id }));
  let destroyed = false;

  /** Repaint the rows only. Never touches the append combobox, so a pick
   *  followed by a repaint leaves focus where the user left it. */
  const paint = (): void => {
    if (listEl.innerHTML !== undefined) {
      listEl.innerHTML = renderFileRefArrayItems(items);
    }
  };

  /** Repaint + report. Every mutation path goes through here, so a rule that
   *  forgets to notify the host cannot exist. */
  const commit = (next: FileRefArrayItem[]): void => {
    items = next;
    paint();
    opts.onChange(fileRefArrayIds(items));
  };

  // ── the append box ────────────────────────────────────────────────
  // A pick appends and CLEARS the combobox, so the next search starts from
  // empty and adding three files is three uninterrupted searches.
  // `setValue` deliberately does not fire `onChange` (see ref-picker/wire),
  // so clearing here cannot re-enter this handler.
  let picker: RefPickerHandle | null = null;
  const pickerId = fileRefArrayVariablePickerId(opts.key, opts.idPrefix);
  if (rowEl.querySelector(`[data-ref-picker="${pickerId}"]`) !== null) {
    picker = wireRefPicker(rowEl as unknown as ParentNode, {
      search: opts.search,
      config: {
        pickerId,
        placeholder: 'Search files to add',
        ariaLabel: `Add a file to ${opts.label}`,
        emptyText: 'No matching files.',
      },
      minChars: 0,
      initialValue: null,
      onChange: (selection) => {
        if (selection === null) return;
        commit(appendFileRef(items, { id: selection.id, label: selection.label }));
        picker?.setValue(null);
      },
    });
  }

  /** Put focus back on the control the user just pressed, at the position it
   *  moved to. `paint` destroys every button node, so without this a
   *  keyboard user loses focus to `<body>` on EVERY press — on a control
   *  whose entire purpose is repeated presses. Falls back to the row's
   *  `remove` (never disabled) when the same action lands disabled at an
   *  end. */
  const refocus = (action: string, index: number): void => {
    if (index < 0) return;
    const at = (want: string): ElementLike | null =>
      rowEl.querySelector(
        `[${FILE_REF_ARRAY_ACTION_ATTR}="${want}"][${FILE_REF_ARRAY_INDEX_ATTR}="${index}"]`,
      );
    const same = at(action);
    const target = same !== null && same.getAttribute('disabled') === null
      ? same
      : at('remove');
    target?.focus?.();
  };

  // ── row controls ──────────────────────────────────────────────────
  // Delegated on the ROW, not on the buttons: `paint` replaces every button
  // node, so a per-button listener would survive exactly one reorder.
  const onClick = (event: EventLike): void => {
    const control = closestWithAttr(event.target, FILE_REF_ARRAY_ACTION_ATTR, rowEl);
    if (control === null) return;
    const action = control.getAttribute(FILE_REF_ARRAY_ACTION_ATTR);
    const raw = control.getAttribute(FILE_REF_ARRAY_INDEX_ATTR);
    const index = raw === null ? NaN : Number(raw);
    if (!Number.isInteger(index)) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (action === 'up') {
      commit(moveFileRef(items, index, -1));
      refocus('up', index === 0 ? 0 : index - 1);
    } else if (action === 'down') {
      commit(moveFileRef(items, index, 1));
      refocus('down', Math.min(index + 1, items.length - 1));
    } else if (action === 'remove') {
      commit(removeFileRef(items, index));
      refocus('remove', Math.min(index, items.length - 1));
    }
  };
  rowEl.addEventListener('click', onClick);

  // ── § 9e — resolve the seeded ids ─────────────────────────────────
  // A dish (or an auto-run row) can hold a `file_ref` whose `data.file` was
  // deleted; nothing refcounts a config overlay, so the id survives its file.
  // Resolve each seeded id against the inventory and relabel it. This
  // repaints WITHOUT reporting: a broken ref stays exactly as stored and is
  // merely SHOWN as broken — relabelling is not an edit. Best-effort; a
  // failing search leaves the raw ids, which is the pre-resolve rendering.
  if (items.length > 0) {
    // One search per distinct seeded id — the inventory answers BY ID, which
    // is how the singular row resolves too. N here is a post's images, not a
    // library.
    const seeded = [...new Set(fileRefArrayIds(items))];
    void Promise.all(
      seeded.map((id) =>
        Promise.resolve(opts.search(id))
          .then((result) => fileRefArrayItem(id, asRefPickerSearchPage(result).options))
          .catch((): FileRefArrayItem => ({ id, label: id })),
      ),
    ).then((resolved) => {
      if (destroyed) return;
      // Re-map by ID, never by position: the user may have reordered,
      // removed, or appended while the inventory was answering, and their
      // ordering wins. Anything picked meanwhile already carries a real
      // label and is left alone.
      const byId = new Map(resolved.map((item) => [item.id, item]));
      items = items.map((item) => byId.get(item.id) ?? item);
      paint();
    });
  }

  return {
    getValue: () => fileRefArrayIds(items),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      rowEl.removeEventListener('click', onClick);
      picker?.destroy();
      picker = null;
    },
  };
};

/** Walk up from `target` (inclusive) to `boundary` (inclusive), returning the
 *  first element carrying `attr`. Mirrors `ref-picker/wire.ts`. */
const closestWithAttr = (
  target: unknown,
  attr: string,
  boundary: ElementLike,
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
  value !== null
  && typeof value === 'object'
  && typeof (value as { getAttribute?: unknown }).getAttribute === 'function';
