/** D-145 § B.11.7 Slice 2c — form-renderer Add/Remove substrate.
 *
 *  Slice 2b shipped the static-render path (`renderForm` → host.innerHTML
 *  + readback via `readFormValues`). The static path leaves the
 *  `data-form-array-add` / `data-form-array-remove` buttons in the DOM
 *  but unwired — so multi-action authoring + deeper combinator nests
 *  in the Settings UI was deferred to v1 pack-install only.
 *
 *  Slice 2c wires those buttons via event delegation on the host
 *  element: one `click` listener on the host dispatches Add/Remove by
 *  reading the click target's `data-form-array-*` attributes + the
 *  ancestor chain. State propagation: read the live DOM values via
 *  `readFormValues`, mutate the target array, re-paint via
 *  `host.innerHTML = renderForm(...)`. The live `<input value>`
 *  attributes are the source of truth between mutations, so the user's
 *  in-progress typing on other inputs is preserved across an Add /
 *  Remove click. New items seed with predictable defaults (first
 *  variant kind for unions, sub-field defaults for objects, first
 *  enum value for arrays-of-enum, empty string / null / false for
 *  scalar items).
 *
 *  ── Surface ────────────────────────────────────────────────────────
 *
 *  `mountForm(host, definition, options)` returns a `FormMount` handle:
 *    - `getValues()` reads the live DOM into a fresh values map. Use
 *      at submit time; the snapshot reflects user typing + Add/Remove
 *      mutations.
 *    - `dispose()` removes the click listener. The host's DOM is NOT
 *      cleared; callers own host lifecycle.
 *
 *  Callers that previously did:
 *    host.innerHTML = renderForm(def, { values });
 *    // ... later ...
 *    const values = readFormValues(host, def);
 *
 *  switch to:
 *    const mount = mountForm(host, def, { values });
 *    // ... later ...
 *    const values = mount.getValues();
 *
 *  ── Path computation ───────────────────────────────────────────────
 *
 *  Add/Remove buttons live INSIDE the form-renderer-array wrapper they
 *  target. For Add, the button's `parentElement` IS the array wrapper;
 *  for Remove, the button's `parentElement` is the array item, and the
 *  array wrapper is one further up. We walk up from the nearest array
 *  wrapper, collecting `(field-name | array-index)` segments via the
 *  `data-form-field` + `data-form-array-item` + `data-form-array-index`
 *  attributes, until we hit the form root. Object / union scope
 *  wrappers contribute no segments (they're inside the object/union's
 *  own `data-form-field` wrapper, which DOES contribute).
 *
 *  Spec: docs/d-145-spec.md § A.3.1 — Slice 2c addendum. */

import {
  type DiscriminatedUnionVariant,
  type FormDefinition,
  type FormField,
} from '@recued/contracts';
import { readFormValues } from './read.js';
import { renderForm, type FormRenderOptions } from './render.js';

export interface MountFormOptions {
  /** Initial values keyed by field name. Same shape as
   *  `FormRenderOptions.values`. The mount stores a copy + re-paints
   *  whenever Add/Remove fires. */
  values?: Readonly<Record<string, unknown>>;
  /** Inline error map keyed by field name. Same shape as
   *  `FormRenderOptions.errors`. */
  errors?: Readonly<Record<string, string>>;
  /** Mirror of `FormRenderOptions.showHidden`. */
  showHidden?: boolean;
}

export interface FormMount {
  /** Snapshot the current values map. Reads from the live DOM via
   *  `readFormValues`, so the result reflects user typing on every
   *  input + any Add/Remove array mutations that fired since mount. */
  getValues(): Record<string, unknown>;
  /** Remove the click listener installed by `mountForm`. The host's
   *  DOM is left intact — callers manage host lifecycle (the SI panel
   *  rebuilds its editor host on every render(), so the orphan host's
   *  listener is GC'd alongside the host itself). Idempotent. */
  dispose(): void;
}

/** Mount a form into `host`. Wires `host.innerHTML` to the initial
 *  render + a single delegated `click` listener that handles Add /
 *  Remove on every `data-form-array-add` / `data-form-array-remove`
 *  descendant. */
export const mountForm = (
  host: HTMLElement,
  definition: FormDefinition,
  options: MountFormOptions = {},
): FormMount => {
  let currentValues: Record<string, unknown> = cloneShallow(options.values ?? {});
  const errors = options.errors;
  const showHidden = options.showHidden ?? false;
  let disposed = false;

  const renderOptions = (): FormRenderOptions => {
    const out: FormRenderOptions = { values: currentValues };
    if (errors !== undefined) out.errors = errors;
    if (showHidden) out.showHidden = true;
    return out;
  };

  const paint = (): void => {
    host.innerHTML = renderForm(definition, renderOptions());
  };

  // PB10 follow-on — union-select change listener. With lazy-expansion
  // variant bodies, only the active variant body is in the DOM; switching
  // kinds requires a re-paint to surface the new variant's affordances.
  // The listener also fixes a latent UX bug for eager unions: pre-PB10,
  // the `data-form-variant-active` markers + CSS-driven visibility were
  // baked at render time, so picking a new kind via the select never
  // updated which body was visible. The handler snapshots live DOM via
  // `readFormValues` (so user typing on other inputs survives the
  // re-paint) and re-paints; the renderer's discriminant lookup picks
  // up the new active kind from the snapshot. Non-union `<select>`
  // changes (enum fields) flow past the early return below — those just
  // store the new value, no re-render needed.
  const handleChange = (event: Event): void => {
    if (disposed) return;
    const target = extractTarget(event);
    if (!target) return;
    if (target.getAttribute('data-form-union-select') === null) return;

    // Snapshot live DOM state BEFORE re-painting so user typing on other
    // inputs survives. The just-changed select's new value flows in via
    // readFormValues — readDiscriminatedUnion queries select.value to
    // pick the active kind, so the snapshot's discriminant reflects the
    // user's just-made choice. For lazy unions the body for the new
    // kind isn't in DOM yet — the read path falls back to
    // `{ [discriminantKey]: kind }` with no other fields, which is
    // exactly the input the renderer needs to render the new variant's
    // body from its declared field defaults.
    currentValues = readFormValues(host as ParentNode, definition);
    paint();
  };

  const handleClick = (event: Event): void => {
    if (disposed) return;
    const target = extractTarget(event);
    if (!target) return;
    const addName = target.getAttribute('data-form-array-add');
    const removeName = target.getAttribute('data-form-array-remove');
    if (addName === null && removeName === null) return;

    // Snapshot live DOM state BEFORE mutating so user typing on other
    // inputs survives the re-paint.
    currentValues = readFormValues(host as ParentNode, definition);

    if (addName !== null) {
      const path = computeArrayPathFromButton(target, host);
      if (path === null) return;
      const arrField = resolveFieldAtPath(definition, currentValues, path);
      if (arrField === null || arrField.type !== 'array') {
        // Codex review fold (MAJOR 1) — stale-union Add. The DOM
        // still shows the previously-active variant body (which
        // contains the clicked Add button), but the user has since
        // picked a different kind in the union <select>. readFormValues
        // observes the NEW kind, and `resolveFieldAtPath` correctly
        // refuses to resolve a path through a variant the live state
        // no longer carries. Without this branch we'd silently drop
        // the Add intent + leave the DOM stale (still painting the
        // old variant body). Re-paint here so the active-variant
        // marker flips to the live kind + the orphaned Add button
        // disappears, surfacing the new variant's affordances. The
        // user's other typed state is already in currentValues, so
        // the re-paint preserves it.
        paint();
        return;
      }
      const defaultItem = computeArrayItemDefault(arrField);
      mutateArrayAtPath(currentValues, path, (arr) => [...arr, defaultItem]);
    } else {
      const idxRaw = target.getAttribute('data-form-array-index');
      if (idxRaw === null) return;
      const idx = Number(idxRaw);
      if (!Number.isInteger(idx) || idx < 0) return;
      const path = computeArrayPathFromButton(target, host);
      if (path === null) return;
      mutateArrayAtPath(currentValues, path, (arr) =>
        arr.filter((_, i) => i !== idx),
      );
    }

    paint();
  };

  host.addEventListener('click', handleClick);
  host.addEventListener('change', handleChange);
  paint();

  return {
    getValues: () => {
      if (disposed) return currentValues;
      // Live DOM is the source of truth between mutations.
      currentValues = readFormValues(host as ParentNode, definition);
      return currentValues;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('click', handleClick);
      host.removeEventListener('change', handleChange);
    },
  };
};

// ════════════════════════════════════════════════════════════════════
// Internals — exported only to the test surface (see `__internal__`).
// ════════════════════════════════════════════════════════════════════

/** Duck-typed event-target extractor. `event.target` is typed `EventTarget
 *  | null`; we only act on real DOM elements that carry the
 *  `getAttribute` interface. Fake-DOM test harnesses that expose
 *  `getAttribute` on their elements compose through this gate. */
const extractTarget = (event: Event): Element | null => {
  const raw = (event as { target?: unknown }).target;
  if (raw === null || raw === undefined) return null;
  const el = raw as { getAttribute?: (k: string) => string | null };
  if (typeof el.getAttribute !== 'function') return null;
  return raw as Element;
};

/** Walk up from `button` to the nearest `[data-form-type="array"]`
 *  wrapper, then continue to the form root, accumulating
 *  (field-name | array-index) segments along the way. Returns null
 *  when the button is not inside the form (defensive — e.g. a synthetic
 *  click event from outside the form host).
 *
 *  Path shape: an array of `string | number` where strings are field
 *  names (object / union / array wrappers) and numbers are array
 *  indices (when traversing INTO an array item). The path terminates
 *  at the target array's NAME — Add/Remove operate on the values map
 *  at that path. Examples:
 *    Top-level `actions` array        → `['actions']`
 *    `actions[0].sources` (sub-array) → `['actions', 0, 'sources']`
 *    Recursive `conditions.conditions`
 *      (outer union, `all` variant)   → `['conditions', 'conditions']` */
const computeArrayPathFromButton = (
  button: Element,
  formHost: Element,
): Array<string | number> | null => {
  let cur: Element | null = parentOf(button);
  while (cur !== null && cur !== formHost) {
    if (cur.getAttribute('data-form-type') === 'array') break;
    cur = parentOf(cur);
  }
  if (cur === null || cur === formHost) return null;

  const path: Array<string | number> = [];
  while (cur !== null && cur !== formHost) {
    if (isFormRoot(cur)) break;
    const dataField = cur.getAttribute('data-form-field');
    const dataType = cur.getAttribute('data-form-type');
    const arrItem = cur.getAttribute('data-form-array-item');
    const arrIdxStr = cur.getAttribute('data-form-array-index');

    if (
      dataField !== null
      && dataType !== null
      && (dataType === 'array'
        || dataType === 'object'
        || dataType === 'discriminated_union')
    ) {
      path.unshift(dataField);
    } else if (arrItem !== null && arrIdxStr !== null) {
      const idx = Number(arrIdxStr);
      if (Number.isInteger(idx) && idx >= 0) {
        path.unshift(idx);
      }
    }
    cur = parentOf(cur);
  }
  return path;
};

/** Walk the form definition along `path` to find the FormField at the
 *  terminating segment. Discriminated_union descents consult the
 *  current values map to pick the active variant — the same kind the
 *  renderer + reader use, so the resolved field matches what's on
 *  screen. Returns null when the path doesn't resolve (substrate
 *  misconfiguration or DOM-vs-state desync; treat as no-op upstream). */
const resolveFieldAtPath = (
  definition: FormDefinition,
  values: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): FormField | null => {
  let fields: ReadonlyArray<FormField> = definition.fields;
  let val: unknown = values;

  for (let i = 0; i < path.length; i += 1) {
    const seg = path[i]!;
    if (typeof seg === 'number') {
      val = Array.isArray(val) ? val[seg] : undefined;
      continue;
    }
    const field = fields.find((f) => f.name === seg);
    if (field === undefined) return null;
    if (i === path.length - 1) return field;

    val = isRecord(val) ? val[seg] : undefined;

    if (field.type === 'array') {
      const itemType = field.item_type;
      if (itemType === 'object') {
        fields = field.item_object_fields ?? [];
      } else if (itemType === 'discriminated_union') {
        const nextIdx = path[i + 1];
        if (typeof nextIdx !== 'number') return null;
        const item = Array.isArray(val) ? val[nextIdx] : undefined;
        const kindKey = field.discriminant_field ?? 'kind';
        const kind = isRecord(item) ? item[kindKey] : undefined;
        const variant = (field.item_variants ?? []).find(
          (v) => v.kind === kind,
        );
        if (variant === undefined) return null;
        fields = variant.fields;
      } else {
        // Array of scalar — can't descend further along a string seg.
        return null;
      }
    } else if (field.type === 'object') {
      fields = field.object_fields ?? [];
    } else if (field.type === 'discriminated_union') {
      const kindKey = field.discriminant_field ?? 'kind';
      const obj = isRecord(val) ? val : undefined;
      const kind = obj?.[kindKey];
      const variant = (field.variants ?? []).find((v) => v.kind === kind);
      if (variant === undefined) return null;
      fields = variant.fields;
    } else {
      // Scalar — can't descend further.
      return null;
    }
  }
  return null;
};

/** Apply `mutator` to the array at `path` inside `values`. The values
 *  map is mutated in place; mountForm OWNS its copy of currentValues
 *  so in-place mutation is safe. */
const mutateArrayAtPath = (
  values: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  mutator: (arr: unknown[]) => unknown[],
): void => {
  if (path.length === 0) return;
  let cur: unknown = values;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i]!;
    if (typeof seg === 'number') {
      cur = Array.isArray(cur) ? cur[seg] : undefined;
    } else {
      cur = isRecord(cur) ? cur[seg] : undefined;
    }
    if (cur === undefined || cur === null) return;
  }
  const last = path[path.length - 1]!;
  if (typeof last === 'number') return; // arrays-of-arrays not supported
  if (!isRecord(cur)) return;
  const target = cur[last];
  const arr = Array.isArray(target) ? target : [];
  cur[last] = mutator(arr);
};

/** Construct a default item for a new array entry. Variant unions seed
 *  with the first declared variant's kind + its sub-field defaults so
 *  the user lands on a non-empty editable item. Object items seed
 *  with object-field defaults. Scalar items map to a typed empty
 *  (null for number, false for boolean, first enum_value for enum,
 *  '' for text/ref/date). */
const computeArrayItemDefault = (arrField: FormField): unknown => {
  const itemType = arrField.item_type;
  if (itemType === 'discriminated_union') {
    const firstVariant = (arrField.item_variants ?? [])[0];
    if (firstVariant === undefined) return null;
    const out: Record<string, unknown> = {
      [arrField.discriminant_field ?? 'kind']: firstVariant.kind,
    };
    seedVariantFields(out, firstVariant);
    return out;
  }
  if (itemType === 'object') {
    const out: Record<string, unknown> = {};
    seedObjectFields(out, arrField.item_object_fields ?? []);
    return out;
  }
  if (itemType === 'enum') {
    return arrField.item_enum_values?.[0] ?? '';
  }
  if (itemType === 'number') return null;
  if (itemType === 'boolean') return false;
  // text / textarea / date / timestamp / ref / uuid → empty string
  return '';
};

const seedVariantFields = (
  out: Record<string, unknown>,
  variant: DiscriminatedUnionVariant,
): void => {
  seedObjectFields(out, variant.fields);
};

const seedObjectFields = (
  out: Record<string, unknown>,
  fields: ReadonlyArray<FormField>,
): void => {
  for (const sub of fields) {
    if (sub.default !== undefined) {
      out[sub.name] = sub.default;
    }
  }
};

const cloneShallow = (
  v: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({ ...v });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const parentOf = (el: Element): Element | null => {
  const node = el as { parentElement?: Element | null };
  return node.parentElement ?? null;
};

const isFormRoot = (el: Element): boolean => {
  const classList = (el as { classList?: { contains?: (s: string) => boolean } })
    .classList;
  return classList?.contains?.('form-renderer-form') === true;
};

// ════════════════════════════════════════════════════════════════════
// Test seam
// ════════════════════════════════════════════════════════════════════

/** Test seam — pure helpers extracted for ratchet testing. Not part of
 *  the public substrate API; ui-shared consumers should drive Add /
 *  Remove via the click event on the mounted host. */
export const __internal__ = {
  computeArrayPathFromButton,
  resolveFieldAtPath,
  mutateArrayAtPath,
  computeArrayItemDefault,
};
