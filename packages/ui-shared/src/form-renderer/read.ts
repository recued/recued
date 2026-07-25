/** D-145 PA5 — DOM read-back for the form renderer.
 *
 *  Walks every `[data-form-field]` element under a root and reconstructs
 *  the typed value map. Each field type has its own read path:
 *    - text / textarea / date / ref / uuid: trimmed input.value
 *    - number: parsed Number; '' → null
 *    - boolean: input.checked
 *    - timestamp: ISO with the local TZ offset; '' → null
 *    - enum: select.value; '' → null when not required
 *    - array: walks `[data-form-array-item="<name>"]`
 *
 *  Spec: docs/d-145-spec.md § A.3.
 */

import {
  evaluateShowIf,
  type DiscriminatedUnionVariant,
  type FormDefinition,
  type FormField,
} from '@recued/contracts';

/** Read every value from a rendered form's DOM root. Slice 2a uses a
 *  TWO-PASS approach so `show_if` evaluation is symmetric with the
 *  renderer's: pass 1 reads every field unconditionally into the
 *  values map (mirroring the renderer's "all variants are in the DOM"
 *  invariant); pass 2 zeros out fields whose `show_if` evaluates to
 *  `false` against the now-complete map. The previous single-pass
 *  implementation evaluated show_if against the partially-built
 *  values map and would surface `undefined` for a field declared
 *  BEFORE its gate sibling — even though the user saw + edited it.
 *  Sub-fields use the same two-pass pattern inside `readFieldGroup`. */
export const readFormValues = (
  root: ParentNode,
  definition: FormDefinition,
): Record<string, unknown> =>
  readFieldGroupScoped(scopeForTopLevel(root), definition.fields);

/** Read a single field's value back. Public so callers can read on
 *  blur / live without re-walking the entire form. Slice 2a — scopes
 *  the lookup to the field's `[data-form-row="<name>"]` wrapper
 *  AS A DIRECT CHILD of the current scope, so a nested object/union
 *  with a same-named inner field cannot collide with the outer read. */
export const readField = (
  root: ParentNode,
  field: FormField,
): unknown => {
  const rowOrSelf = findRowInScope(root, field.name) ?? root;
  if (field.type === 'array') {
    return readArrayField(rowOrSelf, field);
  }
  if (field.type === 'object') {
    return readObjectField(rowOrSelf, field);
  }
  if (field.type === 'discriminated_union') {
    return readDiscriminatedUnionField(rowOrSelf, field);
  }
  const el = (rowOrSelf as ParentNode).querySelector(
    `[data-form-field="${cssEscape(field.name)}"]`,
  );
  if (!el) return field.default;
  return readScalar(el as Element, field.type);
};

const readArrayField = (
  root: ParentNode,
  field: FormField,
): unknown[] => {
  // Slice 2b fold (Codex Blocker #1) — scope the item walk to the
  // array wrapper's direct children so a nested same-named array
  // (e.g. SI's `conditions` inside `all → conditions`) does not
  // querySelectorAll-collide with this outer read. Pre-fold the
  // selector pulled every descendant `data-form-array-item="<name>"`,
  // so an inner combinator's items leaked into the outer array's
  // value list on every round-trip of a depth-2 condition tree.
  //
  // Graceful-degradation discipline: when the parent supports a real
  // DOM hierarchy (real browser + the slice2a-form-composition-read
  // fake) the wrapper-narrowed direct-child walk fires + bounds the
  // read correctly. When the parent is a flat-map fake (the PA5
  // d-145-phase-5-read test's `arrayItems` registry) the wrapper
  // lookup returns null OR yields a node without `children`; the
  // walk falls back to the original descendant-scoped
  // `querySelectorAll`, which is safe in flat-map land because flat
  // maps cannot model nesting in the first place.
  const wrapper = (root as ParentNode).querySelector(
    `[data-form-field="${cssEscape(field.name)}"][data-form-type="array"]`,
  );
  const itemType = field.item_type ?? 'text';
  const itemEls = readArrayItemEls(root, wrapper, field.name);
  // Sort by data-form-array-index so DOM ordering doesn't mis-shuffle.
  itemEls.sort((a, b) => {
    const ai = Number((a as HTMLElement).dataset.formArrayIndex ?? 0);
    const bi = Number((b as HTMLElement).dataset.formArrayIndex ?? 0);
    return ai - bi;
  });
  // Slice 2a — nested-content items read through composite paths.
  if (itemType === 'object') {
    const subFields = field.item_object_fields ?? [];
    return itemEls.map((el) =>
      readFieldGroup(scopeFor(el as Element, field.name), subFields),
    );
  }
  if (itemType === 'discriminated_union') {
    const variants = field.item_variants ?? [];
    const discriminantKey = field.discriminant_field ?? 'kind';
    return itemEls.map((el) =>
      readDiscriminatedUnion(el as Element, field.name, variants, discriminantKey),
    );
  }
  return itemEls.map((el) => readScalar(el as Element, itemType));
};

// ────────────────────────────────────────────────────────────────
// Slice 2a — composition primitives
// ────────────────────────────────────────────────────────────────

const readObjectField = (
  root: ParentNode,
  field: FormField,
): Record<string, unknown> | null => {
  // Object fields ARE addressed by `data-form-field="<name>"` at the
  // wrapper level — the sub-form's children are addressable from
  // within the matching `data-form-object-scope` (matching name).
  const wrapper = root.querySelector(
    `[data-form-field="${cssEscape(field.name)}"][data-form-type="object"]`,
  );
  if (!wrapper) return null;
  const scope = scopeFor(wrapper, field.name);
  const subFields = field.object_fields ?? [];
  return readFieldGroup(scope, subFields);
};

const readDiscriminatedUnionField = (
  root: ParentNode,
  field: FormField,
): Record<string, unknown> | null => {
  const wrapper = root.querySelector(
    `[data-form-field="${cssEscape(field.name)}"][data-form-type="discriminated_union"]`,
  );
  if (!wrapper) return null;
  const variants = field.variants ?? [];
  const discriminantKey = field.discriminant_field ?? 'kind';
  return readDiscriminatedUnion(wrapper, field.name, variants, discriminantKey);
};

/** Shared reader for top-level + in-array discriminated_union shape.
 *  Reads the kind from the `<select>`, finds the matching variant's
 *  body, walks its fields, and emits `{ [discriminantKey]: kind,
 *  ...variantFields }`.
 *
 *  Returns `null` when the declared `variants` list is empty
 *  (substrate misconfiguration) OR the `<select>` element is absent
 *  (hostile / broken DOM — pre-Slice-2a-fold versions silently
 *  defaulted to `variants[0]!.kind` here, rewriting user data on
 *  round-trip). When the selected kind doesn't match any declared
 *  variant, the result carries `{ [discriminantKey]: kind }` only —
 *  the variant body is NOT walked, so no stray fields leak — and
 *  the validator will surface the unknown kind as a closed-list
 *  violation. The renderer's unknown-kind placeholder option is
 *  `disabled`, so this branch is reachable only via a stored value
 *  the registry no longer knows about (e.g. retired pack variants);
 *  the user must pick a declared variant before save lands. */
const readDiscriminatedUnion = (
  scopeRoot: Element,
  fieldName: string,
  variants: ReadonlyArray<DiscriminatedUnionVariant>,
  discriminantKey: string,
): Record<string, unknown> | null => {
  if (variants.length === 0) return null;
  const select = scopeRoot.querySelector(
    `[data-form-union-select="${cssEscape(fieldName)}"]`,
  ) as HTMLSelectElement | null;
  if (!select) return null;
  const kind = select.value;
  const variant = variants.find((v) => v.kind === kind);
  if (!variant) {
    // Preserve the observed (unrecognized) kind so the validator's
    // closed-list check can surface a clear "Must be one of …" error.
    return { [discriminantKey]: kind };
  }
  const body = scopeRoot.querySelector(
    `[data-form-union-scope="${cssEscape(fieldName)}"][data-form-union-variant="${cssEscape(kind)}"]`,
  );
  if (!body) {
    return { [discriminantKey]: kind };
  }
  const fields = readFieldGroup(body, variant.fields);
  return { [discriminantKey]: kind, ...fields };
};

/** Read a flat list of fields against a scoped root. Two-pass to
 *  evaluate `show_if` against the COMPLETE values map (pass 1 reads
 *  unconditionally; pass 2 zeros out hidden fields). Matches the
 *  renderer's show_if semantics (which always sees the full values
 *  map at render time) — single-pass evaluation drops fields the
 *  user actually saw + edited when those fields appeared in the
 *  definition list BEFORE their gate sibling. */
const readFieldGroup = (
  scope: Element,
  fields: ReadonlyArray<FormField>,
): Record<string, unknown> => readFieldGroupScoped(scope, fields);

const readFieldGroupScoped = (
  scope: ParentNode,
  fields: ReadonlyArray<FormField>,
): Record<string, unknown> => {
  // Pass 1 — read every field. show_if gating happens AFTER so a
  // sibling declared after the gated field still gets its value into
  // the map before show_if consults it.
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    values[field.name] = readField(scope, field);
  }
  // Pass 2 — zero out hidden fields against the now-complete map.
  for (const field of fields) {
    if (
      field.show_if !== undefined
      && !evaluateShowIf(field.show_if, values)
    ) {
      delete values[field.name];
    }
  }
  return values;
};

/** Bound the top-level read scope to the form-renderer-form wrapper
 *  when present. The renderer always emits the form wrapper around
 *  the top-level fields; scoping to it ensures `findRowInScope`'s
 *  direct-child walk lands on the top-level rows (not nested
 *  data-form-row wrappers inside composite fields). Falls back to
 *  `root` itself when the wrapper isn't present (custom hosts).
 *
 *  Duck-typed (`classList`/`querySelector`) so the substrate runs
 *  inside the thin fake-DOM harnesses our contract tests use — no
 *  `Element` global required. */
const scopeForTopLevel = (root: ParentNode): ParentNode => {
  const r = root as ParentNode & {
    classList?: { contains?: (s: string) => boolean };
    querySelector?: (s: string) => unknown;
  };
  if (r.classList && r.classList.contains?.('form-renderer-form') === true) {
    return root;
  }
  const wrapper = r.querySelector?.('.form-renderer-form');
  return (wrapper as ParentNode | undefined) ?? root;
};

/** Find the row wrapper for `name` AS A DIRECT CHILD of the current
 *  scope. Returns null when none — caller falls back to scope-wide
 *  search (legacy behavior). Direct-child walking bounds the search
 *  so a nested data-form-row with the same name (e.g. inside a
 *  composite field's sub-form) does not collide with the outer
 *  lookup. Duck-typed for the same fake-DOM reason as above. */
const findRowInScope = (
  scope: ParentNode,
  name: string,
): ParentNode | null => {
  const children = (scope as { children?: Iterable<unknown> }).children;
  if (!children) return null;
  for (const child of children as Iterable<unknown>) {
    const c = child as {
      getAttribute?: (k: string) => string | null;
    } & ParentNode;
    if (c.getAttribute?.('data-form-row') === name) {
      return c;
    }
  }
  return null;
};

/** Narrow the root to the nested scope wrapper named after `field`.
 *  Used by both object reads + array-of-object item reads — the array
 *  item wrapper carries its own `data-form-object-scope="<name>"`. */
const scopeFor = (root: Element, name: string): Element => {
  const inner = root.querySelector(
    `[data-form-object-scope="${cssEscape(name)}"]`,
  );
  return inner ?? root;
};

const readScalar = (
  el: Element,
  type: FormField['type'],
): unknown => {
  if (type === 'boolean') {
    return (el as HTMLInputElement).checked;
  }
  if (type === 'number') {
    const raw = (el as HTMLInputElement).value;
    if (raw === '' || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'timestamp') {
    const raw = (el as HTMLInputElement).value;
    if (!raw) return null;
    return localToIsoWithOffset(raw);
  }
  if (type === 'enum') {
    const raw = (el as HTMLSelectElement).value;
    return raw === '' ? null : raw;
  }
  if (type === 'array' || type === 'object' || type === 'discriminated_union') {
    // Unreachable in scalar path; composite types are routed at the
    // top-level `readField` dispatch + per-item array reader.
    return null;
  }
  // text / textarea / date / ref / uuid — string passthrough; '' → null
  // for non-required surfaces; callers map further if needed.
  const raw = (el as HTMLInputElement | HTMLTextAreaElement).value ?? '';
  return raw;
};

/** Convert a `datetime-local` value (`YYYY-MM-DDTHH:MM`) into a
 *  TZ-explicit ISO string using the runtime's offset. The validator
 *  enforces TZ-explicit on accept, so we never return naive strings. */
const localToIsoWithOffset = (raw: string): string => {
  // raw shape: YYYY-MM-DDTHH:MM[:ss]
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    raw,
  );
  if (!match) return raw; // pass through; validator will flag
  const [, y, mo, d, h, mi, s] = match;
  const yr = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s !== undefined ? Number(s) : 0;
  // Construct a Date from the local components — Date interprets
  // these as the runtime's local time; we then format the result as
  // ISO + the local offset.
  const local = new Date(yr, month - 1, day, hour, minute, second);
  const offsetMin = -local.getTimezoneOffset(); // east is positive
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offHr = pad2(Math.floor(abs / 60));
  const offMi = pad2(abs % 60);
  // Re-format as YYYY-MM-DDTHH:MM:SS±HH:MM (no ms — minute precision
  // is what the input surfaced).
  return `${y}-${mo}-${d}T${h}:${mi}:${pad2(second)}${sign}${offHr}:${offMi}`;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Minimal CSS attribute-value escape. Field names from canonical
 *  schemas are alphanumeric + underscores; extension field names may
 *  carry anything. We escape every non-`[A-Za-z0-9_-]` character with
 *  a backslash so the resulting attribute selector parses cleanly in
 *  any spec-compliant `querySelector` implementation. */
const cssEscape = (s: string): string =>
  s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);

/** Resolve the item-element list for an array field. Prefers the
 *  scope-narrowed direct-child walk against the array's own wrapper
 *  (Slice 2b fold #1 — fixes nested same-named array collision); falls
 *  back to the original descendant scan against `root` when the
 *  wrapper is absent OR the wrapper has no enumerable `children`
 *  (flat-map fake DOMs the PA5 d-145-phase-5-read test uses cannot
 *  model the hierarchy). Both branches converge to the right answer
 *  in real DOM — the fall-back path is reachable only in the
 *  pre-Slice-2a flat-map test discipline. */
const readArrayItemEls = (
  root: ParentNode,
  wrapper: Element | null,
  fieldName: string,
): Element[] => {
  if (wrapper !== null) {
    const direct = directChildrenWithAttr(
      wrapper,
      'data-form-array-item',
      fieldName,
    );
    if (direct.length > 0) return direct;
  }
  // Fall back: descendant scan on root. This matches the pre-fold
  // behavior + remains safe for flat-map fake DOMs that don't model
  // nesting (no nested same-named array can exist in a flat map).
  return Array.from(
    root.querySelectorAll(
      `[data-form-array-item="${cssEscape(fieldName)}"]`,
    ),
  );
};

/** Direct-child walk for elements carrying `attr === value`. Used by
 *  the array reader's scope-narrowed item iteration (Slice 2b fold).
 *  Duck-typed so the substrate runs inside the thin fake-DOM
 *  harnesses our contract tests use — no `Element` global required. */
const directChildrenWithAttr = (
  scope: ParentNode,
  attr: string,
  value: string,
): Element[] => {
  const children = (scope as { children?: Iterable<unknown> }).children;
  if (!children) return [];
  const out: Element[] = [];
  for (const child of children as Iterable<unknown>) {
    const c = child as { getAttribute?: (k: string) => string | null };
    if (c.getAttribute?.(attr) === value) out.push(child as Element);
  }
  return out;
};
