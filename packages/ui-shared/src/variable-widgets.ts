/** Recipe-variable form widgets — shared across install dialog,
 *  schedule editor, and Kitchen editor.
 *
 *  A recipe's `variables` map carries two shapes per entry:
 *    - A primitive default (`number | boolean | string | string[]`),
 *      in which case the widget type is inferred from the JS type.
 *    - A `ValueHint` object (`{ label, type, options?, help?, ... }`),
 *      which lets the author control labelling / options / help text.
 *
 *  `renderVariableWidget` normalises both shapes into a single typed
 *  render path. The output reuses the `typedField` primitive for
 *  string/number/boolean/enum, and adds two widget types the primitive
 *  doesn't cover directly:
 *    - `secret` — password input + "Store in Settings > Connections"
 *      hint when the variable is sourced from a vault-style hint.
 *    - `multi` — grid of checkboxes when the default is a `string[]`
 *      of allowable values.
 *
 *  Callers own the surrounding section styling. Each row is a
 *  `<div class="var-row">` wrapper with label/help/input inside; the
 *  caller prepends/appends any extra chrome (remove button, rename
 *  input, etc.).
 *
 *  The change-event binding is standardised: every input carries
 *  `data-var-key="{name}"` + `data-var-type="{type}"`, so a single
 *  delegated listener on the surface root can read `el.dataset.varKey`
 *  + `el.dataset.varType` and dispatch through `readWidgetValue`.
 *
 *  See `__tests__/variable-widgets.test.ts` for every widget shape
 *  + change-event path.
 */

import type { VariableDefault, ValueHint } from '@recued/contracts';
import { initialRefPickerState } from './ref-picker/model.js';
import { renderRefPicker } from './ref-picker/render.js';
import { e } from './template.js';

export type WidgetType =
  /** D-215 slice 5 — an INSTANT picker. Distinct from `text` because a
   *  bare string is how every time-valued arg in the corpus is declared
   *  today, and a zone-less wall clock parsed server-side resolves in the
   *  SERVER's zone (§ 4.6). */
  | 'datetime'
  /** D-215 slice 5 — an ORDERED list of file refs. Selection order is part
   *  of the value (a carousel), so it is not a set. */
  | 'file_ref_array'
  | 'text'
  /** A multi-LINE string. Every other string-ish widget is a one-line
   *  `<input>`, and a browser strips the newlines out of a multi-line paste on
   *  its way into one — so the value still arrives, as a single run-on
   *  paragraph with every list and heading flattened, and nothing reports that
   *  the structure was lost. Recipes ask for it with `type: 'long_text'`.
   *
   *  ⛔ NOT a widening of `'text'`. The 26 shipped `type: 'text'` variables are
   *  short values (a search window like `pw`, an address), and turning those
   *  into text areas would be a UI change to two dozen recipes nobody asked
   *  for. New name, new widget, existing rows untouched.
   *
   *  ⚠ `readWidgetValue` needs NO branch for this: it falls through to `.value`,
   *  and `HTMLTextAreaElement.value` is the same property. `validateWidgetValue`
   *  likewise treats it as the string it is. */
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multi'
  | 'secret'
  | 'file_ref'
  /** A reference to one of the owner's stored Records rows, chosen from a
   *  search. Carries the entity its picker searches. */
  | 'record_ref';

export interface WidgetShape {
  key: string;
  label: string;
  type: WidgetType;
  help?: string;
  link?: string;
  options?: readonly string[];
  /** For a `record_ref` — the entity its picker searches. Carried through so
   *  the renderer need not re-read the hint. */
  entity?: string;
  /** Optional equality scope for that entity's picker. This is presentation
   *  narrowing only; the operation remains the authority for the value. */
  entityFilter?: Readonly<Record<string, string>>;
  value: unknown;
  optional?: boolean;
}

/** Marker on a `file_ref` variable row (value = recipe variable key). Hosts
 *  with a file-inventory search caller attach the shared RefPicker here; hosts
 *  without one render a pasteable ref input instead. */
export const FILE_REF_VARIABLE_ATTR = 'data-recued-file-ref-variable';

/** D-215 slice 5 residual — the same marker for a `file_ref[]` row. Separate
 *  from the singular attribute so a host's mount loop can never cross-match:
 *  the two widgets differ in their VALUE SHAPE (a string vs an ordered list),
 *  and a picker attached to the wrong one would write the wrong type. */
export const FILE_REF_ARRAY_VARIABLE_ATTR = 'data-recued-file-refs-variable';
/** The ordered `<ol>` inside a `file_ref[]` row. Carries the row's
 *  `data-var-key` / `data-var-type` (mirroring how `multi` puts them on the
 *  checkbox grid) — it IS the value, so it is what `readWidgetValue` walks. */
export const FILE_REF_ARRAY_LIST_ATTR = 'data-recued-file-refs-list';
/** One selected file, value = the stored `file_ref` id. DOM order is the
 *  value's order. */
export const FILE_REF_ARRAY_ITEM_ATTR = 'data-recued-file-refs-item';
/** `up` | `down` | `remove` on a row control. */
export const FILE_REF_ARRAY_ACTION_ATTR = 'data-recued-file-refs-action';
/** The 0-based position the control acts on — read together with the action. */
export const FILE_REF_ARRAY_INDEX_ATTR = 'data-recued-file-refs-index';

export interface VariableWidgetRenderOptions {
  /** Render a name→file_ref combobox shell instead of the fallback text box.
   *  Covers both the singular `file_ref` row and the ordered `file_ref[]` one
   *  — the same owner-file inventory backs both. */
  fileRefPicker?: boolean;
  /** Render a name→record combobox shell for a `record_ref` variable instead
   *  of the fallback text box. Same reason as `fileRefPicker`: the shell is
   *  pure string output, and the host wires the inventory afterwards. */
  recordRefPicker?: boolean;
  /** Unique scope when the same variable widgets coexist in nested overlays. */
  idPrefix?: string;
}

/** Marker on a `record_ref` variable row (value = recipe variable key). */
export const RECORD_REF_VARIABLE_ATTR = 'data-recued-record-ref-variable';
/** The entity a `record_ref` row's picker searches, carried onto the row so a
 *  host wiring the inventory does not have to re-read the recipe. */
export const RECORD_REF_ENTITY_ATTR = 'data-recued-record-ref-entity';
/** Optional equality scope for a `record_ref` variable, serialized as JSON.
 *  The shared wire helper reads the typed shape directly; the marker keeps the
 *  rendered shell inspectable and gives non-standard hosts the same contract. */
export const RECORD_REF_FILTER_ATTR = 'data-recued-record-ref-filter';

/** Marker on an editable GRID CELL whose column is a ref (value = the cell
 *  address, the same one the grid's own change handler reads).
 *
 *  ⛔ A SEPARATE ATTRIBUTE FROM THE VARIABLE ONE, on purpose. A host attaching
 *  pickers walks these to find cells; reusing the variable marker would make a
 *  cell answer to the variable wiring, which reads the recipe's `variables` and
 *  would find nothing under a cell address. Same picker, different anchor. */
export const RECORD_REF_CELL_ATTR = 'data-recued-record-ref-cell';
/** The entity a cell's picker searches — from the column's `references`, which
 *  the schema already knows. Carried onto the cell so the host does not
 *  re-derive it from the table descriptor. */
export const RECORD_REF_CELL_ENTITY_ATTR = 'data-recued-record-ref-cell-entity';
/** Equality scope the cell's picker applies on top of the entity, as JSON.
 *  Absent when unscoped. See `ValueHint.entity_filter` for why an entity that
 *  holds several independent trees needs one. */
export const RECORD_REF_CELL_FILTER_ATTR = 'data-recued-record-ref-cell-filter';

export const recordRefVariablePickerId = (
  key: string,
  idPrefix = 'variable',
): string => `${idPrefix}-record-ref-${key}`;

export const fileRefVariablePickerId = (
  key: string,
  idPrefix = 'variable',
): string => `${idPrefix}-file-ref-${key}`;

/** The APPEND box of a `file_ref[]` row. Provably disjoint from
 *  `fileRefVariablePickerId`: variable keys match `[a-zA-Z_][a-zA-Z0-9_]*`
 *  (no `-`), so after the shared `…-file-ref` stem this id always reads `s-`
 *  where the singular reads `-`. */
export const fileRefArrayVariablePickerId = (
  key: string,
  idPrefix = 'variable',
): string => `${idPrefix}-file-refs-${key}`;

/** One row of a `file_ref[]` value: the stored id plus how it should read. */
export interface FileRefArrayItem {
  /** The committed `file_ref` — what actually travels to the recipe. */
  id: string;
  /** Display text. The owner's inventory supplies it; until it answers, the
   *  id stands in. */
  label: string;
  /** The id no longer resolves in the owner's inventory (D-215 § 9e). Carried
   *  as a FLAG rather than inferred from the label text, so the rendering and
   *  the judgement can't drift apart. */
  missing?: boolean;
}

/** D-215 § 9e — the label prefix a `file_ref` gets when its `data.file` no
 *  longer resolves. Exported so a surface can assert on it rather than on
 *  prose, and so the wording lives in exactly one place.
 *
 *  ⚠ Lives HERE, not in `config-editor-overlay.ts`, because the rule now has
 *  two consumers (the singular row's overlay wiring and `file-ref-array.ts`)
 *  and the overlay imports the array wire — a home in the overlay would make
 *  that a cycle. `config-editor-overlay.ts` re-exports both names unchanged. */
export const MISSING_FILE_PREFIX = 'Missing file — ';

/** D-215 § 9e — resolve a stored `file_ref` against the owner's inventory.
 *
 *  Pure so the rule is testable without a DOM: a host only needs a Document
 *  to paint it. Three cases, and the middle one is the point — before this,
 *  an id with no inventory hit rendered as its own label, i.e. as an ordinary
 *  value, and a dish holding a deleted file looked fine right up until the
 *  run failed. A same-id hit with an EMPTY label counts as missing, because a
 *  blank field is the very blankness § 9e forbids.
 *
 *  ⚠ Returns a LABEL (and a verdict) only. The stored id is never rewritten:
 *  a broken ref stays exactly as the owner saved it and is merely SHOWN as
 *  broken. */
export const fileRefArrayItem = (
  storedId: string,
  options: ReadonlyArray<{ id: string; label: string }>,
): FileRefArrayItem => {
  const hit = options.find((o) => o.id === storedId);
  if (hit !== undefined && hit.label.length > 0) {
    return { id: storedId, label: hit.label };
  }
  return { id: storedId, label: `${MISSING_FILE_PREFIX}${storedId}`, missing: true };
};

/** The § 9e label alone — the singular `file_ref` row's shape, which feeds a
 *  RefPicker `setValue` and has nowhere to put a flag. Delegates so the
 *  resolve rule lives at exactly ONE site: a second copy would let the
 *  singular row and the array row disagree about what "missing" means. */
export const fileRefDisplayLabel = (
  storedId: string,
  options: ReadonlyArray<{ id: string; label: string }>,
): string => fileRefArrayItem(storedId, options).label;

/** Normalise a `VariableDefault` entry to a renderable widget shape. */
export const toWidgetShape = (
  key: string,
  def: VariableDefault,
  override?: unknown,
): WidgetShape => {
  if (isValidValueHint(def)) {
    const type = mapHintType(def);
    const value = override !== undefined ? override : def.default;
    return {
      key,
      label: def.label,
      type,
      help: def.help,
      link: def.link,
      options: def.options,
      ...(typeof def.entity === 'string' ? { entity: def.entity } : {}),
      ...(isStringRecord(def.entity_filter)
        ? { entityFilter: def.entity_filter }
        : {}),
      value,
      optional: def.optional,
    };
  }

  // Primitive default — infer widget type from JS type.
  const value = override !== undefined ? override : def;
  if (typeof def === 'boolean') {
    return { key, label: formatKey(key), type: 'boolean', value };
  }
  if (typeof def === 'number') {
    return { key, label: formatKey(key), type: 'number', value };
  }
  if (Array.isArray(def)) {
    return {
      key,
      label: formatKey(key),
      type: 'multi',
      options: def.map(String),
      value: Array.isArray(value) ? value : def,
    };
  }
  return { key, label: formatKey(key), type: 'text', value };
};

/** Coerce whatever a config holds for a `file_ref[]` variable into the
 *  ordered id list the widget renders.
 *
 *  Accepts BOTH shapes on purpose: an array (what the picker writes) and a
 *  comma-separated string (what the pasteable fallback writes when a host has
 *  no file inventory). A config edited on a picker-less surface and reopened
 *  on a picker-ful one must not read as empty. */
export const toFileRefIds = (value: unknown): string[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length > 0) ids.push(id);
  }
  return ids;
};

/** The `<li>` rows INSIDE a `file_ref[]` list — the surgical-repaint unit,
 *  mirroring `renderRefPickerResultRows`. `file-ref-array.ts` sets the list's
 *  `innerHTML` to this on every reorder/add/remove, so the append combobox
 *  (a sibling, outside the list) keeps its focus and its wiring.
 *
 *  The position is rendered EXPLICITLY rather than left to `<ol>` numbering:
 *  ordering is the part of this value a user can get wrong, so it has to be
 *  legible under any CSS reset — and assertable. */
export const renderFileRefArrayItems = (
  items: readonly FileRefArrayItem[],
): string => {
  if (items.length === 0) {
    return '<li class="var-file-refs-empty">No files chosen yet.</li>';
  }
  const last = items.length - 1;
  return items
    .map((item, index) => {
      const missing = item.missing === true;
      const control = (
        action: 'up' | 'down' | 'remove',
        glyph: string,
        title: string,
        disabled: boolean,
      ): string =>
        `<button type="button" class="var-file-refs-btn"`
        + ` ${FILE_REF_ARRAY_ACTION_ATTR}="${action}"`
        + ` ${FILE_REF_ARRAY_INDEX_ATTR}="${index}"`
        + ` title="${e(title)}" aria-label="${e(`${title}: ${item.label}`)}"`
        + `${disabled ? ' disabled' : ''}>${glyph}</button>`;
      return `<li class="var-file-refs-item${missing ? ' var-file-refs-item--missing' : ''}"`
        + ` ${FILE_REF_ARRAY_ITEM_ATTR}="${e(item.id)}">`
        + `<span class="var-file-refs-pos">${index + 1}</span>`
        + `<span class="var-file-refs-label">${e(item.label)}</span>`
        + control('up', '↑', 'Move earlier', index === 0)
        + control('down', '↓', 'Move later', index === last)
        + control('remove', '×', 'Remove', false)
        + `</li>`;
    })
    .join('');
};

/** Render a single variable widget. Returns a `<div class="var-row">`
 *  block with label + optional help + the type-specific input. */
export const renderVariableWidget = (
  w: WidgetShape,
  options: VariableWidgetRenderOptions = {},
): string => {
  const id = `${options.idPrefix ?? 'var'}-${w.key}`;
  const help = w.help
    ? `<p class="var-help">${e(w.help)}${
        w.link
          ? ` <a href="${e(w.link)}" target="_blank" rel="noopener">Learn more</a>`
          : ''
      }</p>`
    : '';

  if (w.type === 'boolean') {
    const checked = w.value === true || w.value === 'true';
    return `
      <div class="var-row var-row-inline">
        <label for="${e(id)}">
          <input
            id="${e(id)}"
            type="checkbox"
            data-var-key="${e(w.key)}"
            data-var-type="boolean"
            ${checked ? 'checked' : ''}
          />
          ${e(w.label)}
          ${w.optional ? '<span class="var-optional">optional</span>' : ''}
        </label>
        ${help}
      </div>
    `;
  }

  if (w.type === 'select') {
    const options = w.options ?? [];
    const selected = String(w.value ?? options[0] ?? '');
    return `
      <div class="var-row">
        <label for="${e(id)}">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</label>
        ${help}
        <select
          id="${e(id)}"
          data-var-key="${e(w.key)}"
          data-var-type="select"
        >
          ${options
            .map(
              (opt) =>
                `<option value="${e(opt)}" ${opt === selected ? 'selected' : ''}>${e(opt)}</option>`,
            )
            .join('')}
        </select>
      </div>
    `;
  }

  if (w.type === 'multi') {
    const options = w.options ?? [];
    const current = new Set(
      (Array.isArray(w.value) ? w.value : []).map(String),
    );
    return `
      <div class="var-row var-row-multi">
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        <div class="var-multi-grid" data-var-key="${e(w.key)}" data-var-type="multi">
          ${options
            .map((opt) => {
              const optId = `${id}-${opt}`;
              const on = current.has(opt);
              return `
                <label for="${e(optId)}" class="var-multi-opt">
                  <input
                    id="${e(optId)}"
                    type="checkbox"
                    data-var-key="${e(w.key)}"
                    data-var-type="multi"
                    data-option="${e(opt)}"
                    ${on ? 'checked' : ''}
                  />
                  <span>${e(opt)}</span>
                </label>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  if (w.type === 'secret') {
    const display = w.value === undefined || w.value === null ? '' : String(w.value);
    return `
      <div class="var-row">
        <label for="${e(id)}">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</label>
        ${help}
        <input
          id="${e(id)}"
          type="password"
          data-var-key="${e(w.key)}"
          data-var-type="secret"
          value="${e(display)}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    `;
  }

  if (w.type === 'record_ref' && options.recordRefPicker === true) {
    // The id is seeded as its own label: this is a PURE string renderer, so the
    // inventory has not been consulted. The host resolves the real label when
    // it wires the picker — the same two-step `file_ref` uses, and the same
    // reason a stale id shows as an id rather than silently as a name.
    const selected = typeof w.value === 'string' && w.value.length > 0
      ? { id: w.value, label: w.value }
      : null;
    const pickerId = recordRefVariablePickerId(w.key, options.idPrefix);
    const entity = typeof w.entity === 'string' ? w.entity : '';
    const filterAttr = w.entityFilter !== undefined
      ? ` ${RECORD_REF_FILTER_ATTR}="${e(JSON.stringify(w.entityFilter))}"`
      : '';
    return `
      <div class="var-row" ${RECORD_REF_VARIABLE_ATTR}="${e(w.key)}" ${RECORD_REF_ENTITY_ATTR}="${e(entity)}"${filterAttr}>
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        ${renderRefPicker(initialRefPickerState(selected), {
          pickerId,
          placeholder: entity === '' ? 'Search records' : `Search ${entity.replace(/_/g, ' ')}`,
          ariaLabel: `Choose ${w.label}`,
          emptyText: 'No matching records.',
        })}
        <input type="hidden" data-var-key="${e(w.key)}" data-var-type="record_ref"
          value="${e(selected?.id ?? '')}" />
      </div>
    `;
  }

  if (w.type === 'file_ref' && options.fileRefPicker === true) {
    const selected = typeof w.value === 'string' && w.value.length > 0
      ? { id: w.value, label: w.value }
      : null;
    const pickerId = fileRefVariablePickerId(w.key, options.idPrefix);
    return `
      <div class="var-row" ${FILE_REF_VARIABLE_ATTR}="${e(w.key)}">
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        ${renderRefPicker(initialRefPickerState(selected), {
          pickerId,
          placeholder: 'Search files',
          ariaLabel: `Choose ${w.label}`,
          emptyText: 'No matching files.',
        })}
        <input type="hidden" data-var-key="${e(w.key)}" data-var-type="file_ref"
          value="${e(selected?.id ?? '')}" />
      </div>
    `;
  }

  if (w.type === 'file_ref_array' && options.fileRefPicker === true) {
    // Seeded labels are the raw ids: this is a PURE string renderer, so the
    // inventory has not been consulted yet. `wireFileRefArray` resolves them
    // and repaints — which is also where a deleted file becomes
    // `Missing file — …` (§ 9e).
    const items: FileRefArrayItem[] = toFileRefIds(w.value)
      .map((fileId) => ({ id: fileId, label: fileId }));
    const pickerId = fileRefArrayVariablePickerId(w.key, options.idPrefix);
    return `
      <div class="var-row" ${FILE_REF_ARRAY_VARIABLE_ATTR}="${e(w.key)}">
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        <ol class="var-file-refs" ${FILE_REF_ARRAY_LIST_ATTR}="${e(w.key)}"
          data-var-key="${e(w.key)}" data-var-type="file_ref_array"
          aria-label="${e(`${w.label} — chosen files, in order`)}"
        >${renderFileRefArrayItems(items)}</ol>
        ${renderRefPicker(initialRefPickerState(null), {
          pickerId,
          placeholder: 'Search files to add',
          ariaLabel: `Add a file to ${w.label}`,
          emptyText: 'No matching files.',
        })}
      </div>
    `;
  }

  if (w.type === 'textarea') {
    return `
    <div class="var-row">
      <label for="${e(id)}">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</label>
      ${help}
      <textarea
        id="${e(id)}"
        rows="10"
        data-var-key="${e(w.key)}"
        data-var-type="textarea"
      >${e(w.value === null || w.value === undefined ? '' : String(w.value))}</textarea>
    </div>
  `;
  }

  // text | number | file_ref | file_ref_array fallback (paste durable refs
  // when the host has no inventory-search caller).
  const inputType = w.type === 'number'
    ? 'number'
    // D-215 slice 5 — the browser's own instant picker. The VALUE it emits
    // is a zone-less wall clock, so a consumer must resolve it against the
    // owner's zone before it travels (the run-modal's `parseLocalDateTime`
    // is the worked example).
    : w.type === 'datetime' ? 'datetime-local' : 'text';
  // The `file_ref[]` fallback is an explicit comma-separated list that
  // `readWidgetValue` splits back. `String([…])` would round-trip through
  // this box only by coincidence, and not at all once a value arrives as a
  // string from a previous pass through the same box.
  const display = w.type === 'file_ref_array'
    ? toFileRefIds(w.value).join(', ')
    : w.value === undefined || w.value === null ? '' : String(w.value);
  return `
    <div class="var-row">
      <label for="${e(id)}">${e(w.label)}${
    w.optional ? ' <span class="var-optional">optional</span>' : ''
  }</label>
      ${help}
      <input
        id="${e(id)}"
        type="${inputType}"
        data-var-key="${e(w.key)}"
        data-var-type="${w.type}"
        value="${e(display)}"
        ${w.type === 'file_ref' ? 'placeholder="file:…" spellcheck="false"' : ''}
        ${w.type === 'file_ref_array' ? 'placeholder="file:…, file:…" spellcheck="false"' : ''}
      />
    </div>
  `;
};

/** Read a widget's current value back from the DOM. Accepts any
 *  element carrying `data-var-key` + `data-var-type` — callers
 *  typically receive it via a delegated `input`/`change` listener.
 *
 *  For `multi`, pass the container element (`.var-multi-grid`) or
 *  any of its inner checkboxes — the reader walks up/down to find
 *  all option checkboxes and returns the selected subset.
 */
export const readWidgetValue = (el: Element): unknown => {
  const type = (el as HTMLElement).dataset.varType;
  const key = (el as HTMLElement).dataset.varKey;
  if (!type || !key) return undefined;

  if (type === 'boolean') {
    return (el as HTMLInputElement).checked;
  }
  if (type === 'number') {
    const raw = (el as HTMLInputElement).value;
    if (raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'multi') {
    // Find the container, then every option checkbox inside.
    const container =
      (el as HTMLElement).matches('.var-multi-grid')
        ? (el as HTMLElement)
        : (el as HTMLElement).closest('.var-multi-grid');
    if (!container) return [];
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-option]'),
    );
    return boxes.filter((b) => b.checked).map((b) => b.dataset.option!);
  }
  if (type === 'file_ref_array') {
    // Two renderings, one reader. With a file inventory the ORDERED `<li>`
    // rows are the value — DOM order IS the order, exactly as the `multi`
    // grid's checkboxes are its value. Without one, the row is a pasteable
    // comma-separated box. Either way this returns an ARRAY: a `file_ref[]`
    // variable that read back as a string would hand the recipe the wrong
    // type without any surface complaining.
    const listSelector = `[${FILE_REF_ARRAY_LIST_ATTR}]`;
    const list =
      (el as HTMLElement).matches(listSelector)
        ? (el as HTMLElement)
        : (el as HTMLElement).closest(listSelector);
    if (!list) return toFileRefIds((el as HTMLInputElement).value);
    return Array.from(list.querySelectorAll(`[${FILE_REF_ARRAY_ITEM_ATTR}]`))
      .map((item) => item.getAttribute(FILE_REF_ARRAY_ITEM_ATTR) ?? '')
      .filter((fileId) => fileId.length > 0);
  }
  // text | number(fallthrough handled above) | select | secret
  return (el as HTMLInputElement | HTMLSelectElement).value;
};

/** Pure validator — returns an error message if the current value
 *  violates the widget's constraints, or null when it's acceptable.
 *  Only flags structural mismatches (required-but-empty, enum
 *  not-in-options). Install-dialog callers already soften
 *  "required" into a non-blocker; they just display the message. */
export const validateWidgetValue = (
  w: WidgetShape,
  value: unknown,
): string | null => {
  if (w.optional) return null;

  // `datetime` rides the string branch: its control emits a string, and a
  // required-but-empty one was silently valid before this — the same gap the
  // `file_ref_array` clause below closes, in the widget slice 5 shipped
  // alongside it.
  // ⛔ `textarea` BELONGS IN THIS LIST, AND ITS ABSENCE FAILS OPEN. A widget type
  // that is not named here falls past every branch and returns null — "no
  // complaint" — so a REQUIRED long-text variable left empty would submit
  // silently. The list is what advertises; adding a member to `WidgetType`
  // without adding it here is exactly how a closed vocabulary matches its own
  // union and still lies.
  if (
    w.type === 'text' || w.type === 'textarea' || w.type === 'secret'
    || w.type === 'file_ref' || w.type === 'datetime'
  ) {
    if (typeof value !== 'string' || value.trim() === '') return 'Required';
    return null;
  }
  if (w.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
    return null;
  }
  if (w.type === 'boolean') {
    return null; // always valid
  }
  if (w.type === 'select') {
    const options = w.options ?? [];
    if (options.length === 0) return null;
    if (typeof value !== 'string' || !options.includes(value)) {
      return `Must be one of ${options.join(', ')}`;
    }
    return null;
  }
  if (w.type === 'multi') {
    if (!Array.isArray(value) || value.length === 0) return 'Choose at least one';
    return null;
  }
  if (w.type === 'file_ref_array') {
    // Accepts only the ARRAY shape — a leftover string from the pasteable
    // fallback is exactly the mismatch worth flagging here, and
    // `readWidgetValue` never produces one.
    if (!Array.isArray(value) || value.length === 0) return 'Choose at least one file';
    return null;
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

/** D-222 — runtime discriminator matching the install validator. The old
 *  `'label' in v` check accepted empty labels and objects without a type; the
 *  invoke visibility rule must be total over values a renderer receives. */
export const isValidValueHint = (v: VariableDefault): v is ValueHint =>
  v !== null
  && typeof v === 'object'
  && !Array.isArray(v)
  && typeof (v as { label?: unknown }).label === 'string'
  && (v as { label: string }).label.trim().length > 0
  && typeof (v as { type?: unknown }).type === 'string'
  && (v as { type: string }).type.trim().length > 0;

/** D-222 Slice 0 — first-class one-shot inputs. Labeled ValueHints are the
 *  authored "ask me" signal; `null` remains the compatibility required-text
 *  input so a valid recipe cannot be offered a run path that withholds its
 *  required value. Configure surfaces intentionally do not use this filter. */
export const isInvocationVariable = (v: VariableDefault): boolean =>
  v === null || isValidValueHint(v);

const mapHintType = (hint: ValueHint): WidgetType => {
  // ⛔⛔ COMPARED AS A STRING, DELIBERATELY, AND NOT BY ADDING A UNION MEMBER.
  // `long_text` is one of the authored types that runs ahead of `ValueHintType`
  // — the same set as `string`, `connection`, `array`, `object`, `json`, and the
  // contract's own header comment RULES on it: an unknown type is admitted and
  // falls back to text (D-222 § 7), and adding one member to close a typecheck
  // lane leaves the other five open while asserting support the union does not
  // have. `chat-catalog.ts` branches on `'array'` the same way. The measured
  // table in `value-hint.ts` names this type, and a test machine-checks that the
  // table and the corpus agree in both directions.
  if ((hint.type as string) === 'long_text') return 'textarea';
  switch (hint.type) {
    case 'secret':
      return 'secret';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'select';
    case 'file_ref':
      return 'file_ref';
    case 'record_ref':
      return 'record_ref';
    case 'file_ref[]':
      return 'file_ref_array';
    case 'datetime':
      return 'datetime';
    case 'url':
    case 'text':
    default:
      // ⚠ FAIL-SAFE ON AN UNKNOWN TYPE, WHICH IS WHAT A VERSION SKEW LOOKS LIKE.
      // A self-hosted server can be newer than the webclient paired to it, so a
      // recipe declaring a type this build has never heard of lands here — and a
      // one-line input is a degraded control, not a broken one.
      return 'text';
  }
};

const formatKey = (k: string): string =>
  k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const isStringRecord = (
  value: unknown,
): value is Readonly<Record<string, string>> =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.entries(value as Record<string, unknown>)
    .every(([key, entry]) => key.length > 0 && typeof entry === 'string');
