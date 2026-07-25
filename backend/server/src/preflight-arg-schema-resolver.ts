/** D-173 P1 / N.6 — `ArgEditSchema` resolver (the edit-form contract).
 *
 *  THE SHARED SEAM. `reception.inbox.approve` (Lane I) imports
 *  `resolveArgEditSchema` to (a) fill `InboxItem.arg_schema` for the
 *  approval form and (b) validate the approve-time `edits` payload before
 *  it persists them as the checkpoint's arg-overrides (D-173 N.5). The
 *  consolidator boot-wiring step injects the runtime `deps`; this module
 *  is pure + dependency-injected — no global state, no side effects.
 *
 *  `ArgEditSchema` is NOT free over today's schemas (N.6, BLOCKER-3): an
 *  installed `OperationSpec` carries `request_schema` but the decomposer
 *  DROPS `editable_args` when it builds the catalog (`decomposer.ts`
 *  `operationSpec` omits it), and entity-field type/privacy lives on the
 *  separately-stored `entity_schemas` (`MetaField`). So the resolver is
 *  the intersection of three runtime facts, each supplied by `deps`:
 *
 *    1. `editable_args`  — the allowlist (D-170 N.7 operation-family field).
 *                          ONLY these op args are user-editable; every
 *                          other arg is immutable (the authored/prefilled
 *                          value stands). Absent / empty ⇒ nothing editable.
 *    2. `request_schema` — the operation's request shape. Used to lift
 *                          `min` / `max` / `pattern` validation where the
 *                          schema typed them and the field didn't.
 *
 *       ⛔ IT DOES NOT GATE. This line used to claim it also gated "an
 *       `editable_args` key to one the operation actually accepts" — it never
 *       did: `resolveSchemaProperty` returns no node for an unknown key and
 *       the loop below pushes the field regardless. The claim was struck
 *       rather than implemented, because implementing it as written is a
 *       BREAKING change measured, not guessed: across `community/packs/`,
 *       **513 of 5,553 declared editable keys** would stop resolving — and
 *       the sample is dominated by dotted container paths (`query.status`,
 *       `body.data`, `query.offset`) whose packs declare the container
 *       without enumerating its properties. That is a schema-SHAPE mismatch,
 *       not a pack naming args its operation rejects, so the gate would
 *       remove legitimately-editable fields from ~190 packs.
 *
 *       The bound that actually holds is `editable_args` itself: a key absent
 *       from it is refused at the inbox (`edit_not_allowed`), and no-
 *       `editable_args` resolves to `{ fields: [] }` — fail-closed. The
 *       missing narrowing is a SECOND fence, not the only one.
 *
 *       ⏭ If the gate is wanted, the schema-shape work comes first: audit the
 *       190 packs that declare a `request_schema`, make container properties
 *       enumerable, then land the gate with that census as the acceptance
 *       test. ⇒ [[declared_is_not_backed]]
 *    3. entity-field     — the materialize target's `MetaField` for the
 *       type / privacy     same canonical key → carries the authoritative
 *                          `MetaFieldType` (string|number|boolean|datetime|
 *                          json) + the D-167 `EntityFieldPrivacy` tag that
 *                          drives sealed-PII reveal-on-edit.
 *
 *  Precedence is field-declares-wins, then entity-field, then schema:
 *  an `ArgEditField` that already declares `type` / `privacy` / `label` /
 *  `validation` keeps it (the pack author is the trust authority); a gap is
 *  filled from the entity field, then the request schema. `affects_target`
 *  is forced true for destination / connection keys (`calendar_id`,
 *  `source_id`) per N.5 §3 — editing one re-resolves `approved_target`.
 *
 *  Spec: D-173 § N.6 + § N.5. */

import {
  isMetaFieldType,
  isEntityFieldPrivacy,
  type ArgEditField,
  type ArgEditSchema,
  type EntityFieldPrivacy,
  type MetaFieldType,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// The resolved schema (N.6). `ArgEditSchema` is OWNED by Lane I in
// `@recued/contracts` (`reception-inbox.ts`) — `{ fields: ArgEditField[] }`.
// We import + return it; we never redefine it. The resolver produces a
// `ResolvedArgEditField` per entry (a structural superset of `ArgEditField`
// — all the optional fields made concrete), assignable to `ArgEditField[]`.
// ────────────────────────────────────────────────────────────────

export type { ArgEditSchema };

/** A fully-resolved edit field. Structurally a superset of the authored
 *  `ArgEditField` (so a `ResolvedArgEditField[]` is assignable to the
 *  contract `ArgEditSchema.fields: ArgEditField[]`), but with `type` /
 *  `label` / `required` / `affects_target` made non-optional (resolved to
 *  concrete values) so the form + the approve-time validator never have to
 *  re-derive a default. */
export interface ResolvedArgEditField {
  /** Arg path on the operation's `request_schema` (e.g. `start_at`,
   *  `calendar_id`, `request.email`). */
  key: string;
  type: MetaFieldType;
  label: string;
  required: boolean;
  privacy?: EntityFieldPrivacy;
  /** Picker source (calendar list, destination source list) → a D-170
   *  `dynamicOptions` key. */
  options_source?: string;
  /** Editing this re-resolves `approved_target` at approve time (N.5 §3). */
  affects_target: boolean;
  validation?: { min?: number; max?: number; pattern?: string };
}

// ────────────────────────────────────────────────────────────────
// Dependency-injected runtime lookups (the seam Lane I + tests inject).
// ────────────────────────────────────────────────────────────────

/** What the runtime knows about one installed operation, by its fully-
 *  qualified `operation_id` (the projection / write-back op the held
 *  approval names). `editable_args` is the N.7 allowlist; `request_schema`
 *  is the installed `OperationSpec.request_schema`. Both optional — an op
 *  with no `editable_args` resolves to an empty (no-edit) schema. */
export interface ResolvedOperationCatalogEntry {
  editable_args?: readonly ArgEditField[];
  request_schema?: unknown;
}

/** The materialize target's canonical field facets, keyed on the same arg
 *  path. Sourced from the destination entity's `MetaField` rows (work-
 *  entity canonical fields for task/note/commitment/project; contact
 *  fields for the `contact.upsert` path). */
export interface ResolvedTargetField {
  type?: MetaFieldType;
  privacy?: EntityFieldPrivacy;
  label?: string;
  required?: boolean;
}

export interface ArgEditSchemaResolverDeps {
  /** Resolve the installed operation row (editable_args allowlist +
   *  request_schema) by fully-qualified `operation_id`. Returns null when
   *  the op is unknown — the resolver then yields an empty schema (nothing
   *  editable; fail-closed). MUST be side-effect-free. */
  readonly lookupOperation: (operationId: string) => ResolvedOperationCatalogEntry | null;
  /** Resolve the materialize target's field facets for one arg `key`.
   *  Returns null/undefined when the key has no canonical field — the
   *  field then falls back to its `editable_args` declaration + the
   *  request schema. MUST be side-effect-free. */
  readonly lookupTargetField?: (operationId: string, key: string) => ResolvedTargetField | null | undefined;
}

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keys whose edit re-resolves the approved target (N.5 §3). A consciously
 *  human-chosen destination / connection at approve time — the opposite of
 *  the op-identity drift guard, which catches a target changed BEHIND the
 *  user's back. Matched on the leaf segment so `sync_target.source_id`
 *  counts too. */
const TARGET_AFFECTING_LEAF_KEYS: ReadonlySet<string> = new Set([
  'source_id',
  'calendar_id',
  'connection_id',
  'connection_name',
  'destination_source_id',
]);

const leafOf = (key: string): string => {
  const idx = key.lastIndexOf('.');
  return idx === -1 ? key : key.slice(idx + 1);
};

const isTargetAffectingKey = (key: string): boolean =>
  TARGET_AFFECTING_LEAF_KEYS.has(leafOf(key));

/** Title-case fallback label from an arg key (`start_at` → `Start At`,
 *  `request.email` → `Email`). */
const labelFromKey = (key: string): string => {
  const leaf = leafOf(key);
  return (
    leaf
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(' ') || key
  );
};

/** Resolve one JSON-Schema-ish property node for an arg key out of the
 *  operation's `request_schema`. Supports the common
 *  `{ type:'object', properties:{...}, required:[...] }` shape (incl. dotted
 *  keys walked segment-by-segment through nested `properties`). Returns the
 *  property node + whether the schema marks it required. Lenient: an opaque
 *  / non-object schema yields `{}` (the field falls back to its own
 *  declaration). */
const resolveSchemaProperty = (
  requestSchema: unknown,
  key: string,
): { node?: Record<string, unknown>; schemaRequired?: boolean } => {
  if (!isPlainObject(requestSchema)) return {};
  let cursor: Record<string, unknown> = requestSchema;
  let schemaRequired: boolean | undefined;
  const segments = key.split('.');
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const props = isPlainObject(cursor.properties) ? cursor.properties : undefined;
    if (props === undefined || !isPlainObject(props[seg])) return { schemaRequired };
    // `required` is declared on the PARENT object node, listing its
    // required property names — capture it for the final segment only.
    if (i === segments.length - 1 && Array.isArray(cursor.required)) {
      schemaRequired = (cursor.required as unknown[]).includes(seg);
    }
    cursor = props[seg] as Record<string, unknown>;
  }
  return { node: cursor, schemaRequired };
};

/** Map a JSON-Schema `type` string to a `MetaFieldType`. `integer` →
 *  `number`; `array` / `object` → `json`; an unknown / absent type → null
 *  (caller falls back). */
const metaTypeFromSchemaNode = (node: Record<string, unknown> | undefined): MetaFieldType | null => {
  if (node === undefined) return null;
  const t = node.type;
  if (t === 'string') {
    // A `format: date-time` string is a datetime field for the form.
    return node.format === 'date-time' || node.format === 'date' ? 'datetime' : 'string';
  }
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array' || t === 'object') return 'json';
  return null;
};

/** Lift `{ min, max, pattern }` from a schema property node where typed.
 *  `minimum` / `maximum` → numeric bounds; `pattern` → regex string.
 *  Returns undefined when none apply (so the field carries no empty
 *  `validation` object). */
const validationFromSchemaNode = (
  node: Record<string, unknown> | undefined,
): { min?: number; max?: number; pattern?: string } | undefined => {
  if (node === undefined) return undefined;
  const out: { min?: number; max?: number; pattern?: string } = {};
  if (typeof node.minimum === 'number') out.min = node.minimum;
  if (typeof node.maximum === 'number') out.max = node.maximum;
  if (typeof node.pattern === 'string' && node.pattern.length > 0) out.pattern = node.pattern;
  return Object.keys(out).length > 0 ? out : undefined;
};

// ────────────────────────────────────────────────────────────────
// The resolver
// ────────────────────────────────────────────────────────────────

/** Resolve the `ArgEditSchema` for a held approval-required operation.
 *
 *  `operationId` — the fully-qualified op id (`<publisher>/<slug>.<op>`)
 *    the held approval names.
 *  `prefilledArgs` — the projection's authored args (the values the inbox
 *    pre-fills the form with). The resolver does NOT mutate them; it uses
 *    them only as a presence hint (a `required` editable arg whose
 *    prefilled value is absent stays `required: true`).
 *  `deps` — the injected runtime lookups (operation row + target field).
 *
 *  Returns `{ fields }` — the allowlist of editable args. Args absent from
 *  `editable_args` are omitted (immutable). An unknown op, or an op with no
 *  `editable_args`, yields `{ fields: [] }` (fail-closed: nothing editable).
 *
 *  Pure + side-effect-free: it reads only its arguments + `deps`, mutates
 *  nothing, and returns a fresh object every call. */
export const resolveArgEditSchema = (
  operationId: string,
  prefilledArgs: Record<string, unknown>,
  deps: ArgEditSchemaResolverDeps,
): ArgEditSchema => {
  const entry = deps.lookupOperation(operationId);
  // Unknown op or no allowlist → nothing editable (fail-closed). The
  // authored args still apply at the gate; the user just can't edit them.
  const editableArgs = entry?.editable_args;
  if (entry === null || editableArgs === undefined || editableArgs.length === 0) {
    return { fields: [] };
  }

  const requestSchema = entry.request_schema;
  const seen = new Set<string>();
  const fields: ResolvedArgEditField[] = [];

  for (const declared of editableArgs) {
    if (typeof declared.key !== 'string' || declared.key.length === 0) continue;
    // Dedupe — a malformed pack that lists a key twice resolves once
    // (first declaration wins).
    if (seen.has(declared.key)) continue;
    seen.add(declared.key);

    const { node: schemaNode, schemaRequired } = resolveSchemaProperty(requestSchema, declared.key);
    const targetField = deps.lookupTargetField?.(operationId, declared.key) ?? undefined;

    // ── type ── field-declares-wins → entity field → request schema →
    //    `string` (the safe text default). Validate the field's own type
    //    so a malformed pack can't smuggle a non-vocab type through.
    const declaredType = isMetaFieldType(declared.type) ? declared.type : undefined;
    const type: MetaFieldType =
      declaredType
      ?? (targetField?.type !== undefined && isMetaFieldType(targetField.type) ? targetField.type : undefined)
      ?? metaTypeFromSchemaNode(schemaNode)
      ?? 'string';

    // ── privacy ── field-declares-wins → entity field. Drives sealed-PII
    //    reveal-on-edit (N.6). Validated against the D-167 vocab.
    const declaredPrivacy =
      declared.privacy !== undefined && isEntityFieldPrivacy(declared.privacy) ? declared.privacy : undefined;
    const targetPrivacy =
      targetField?.privacy !== undefined && isEntityFieldPrivacy(targetField.privacy)
        ? targetField.privacy
        : undefined;
    const privacy = declaredPrivacy ?? targetPrivacy;

    // ── required ── field-declares-wins → entity field → request schema's
    //    `required[]` → false.
    const required =
      typeof declared.required === 'boolean'
        ? declared.required
        : typeof targetField?.required === 'boolean'
          ? targetField.required
          : schemaRequired ?? false;

    // ── label ── field-declares-wins → entity field → title-cased key.
    const label =
      typeof declared.label === 'string' && declared.label.length > 0
        ? declared.label
        : typeof targetField?.label === 'string' && targetField.label.length > 0
          ? targetField.label
          : labelFromKey(declared.key);

    // ── affects_target ── declared OR a known destination/connection key
    //    (N.5 §3). A picker over a destination is target-affecting by
    //    construction.
    const affects_target = declared.affects_target === true || isTargetAffectingKey(declared.key);

    // ── validation ── field-declares-wins → lifted from the request schema
    //    where typed (min/max/pattern). The field's own declaration is kept
    //    verbatim; the schema only fills a wholly-absent block.
    const validation =
      declared.validation !== undefined ? declared.validation : validationFromSchemaNode(schemaNode);

    const field: ResolvedArgEditField = {
      key: declared.key,
      type,
      label,
      required,
      affects_target,
    };
    if (privacy !== undefined) field.privacy = privacy;
    if (declared.options_source !== undefined && declared.options_source.length > 0) {
      field.options_source = declared.options_source;
    }
    if (validation !== undefined) field.validation = validation;
    fields.push(field);
  }

  return { fields };
};

/** Build the runtime operation-catalog `deps.lookupOperation` over an
 *  injectable installed-operation source.
 *
 *  The decompose path strips `editable_args` from the installed
 *  `OperationSpec` (it survives only on the authored `OperationRow`), so a
 *  runtime lookup MUST read it from a source that preserves the authored
 *  rows. This factory takes two narrow injectable readers so the boot wire
 *  can point them at the live stores and tests can fake them:
 *
 *    - `getRequestSchema(operationId)` — the installed op's request_schema
 *      (from the live manifest registry / local-manifest store catalog).
 *    - `getEditableArgs(operationId)`  — the authored `editable_args`
 *      allowlist (from the composition / operation-family source that keeps
 *      it; the consolidator wires the reception core-pack op rows here).
 *
 *  Both return null/undefined for an unknown op → the catalog entry carries
 *  whatever the other reader found (or null when neither does). Pure: the
 *  returned function only calls the injected readers. */
export const createOperationCatalogLookup = (readers: {
  readonly getRequestSchema?: (operationId: string) => unknown;
  readonly getEditableArgs?: (operationId: string) => readonly ArgEditField[] | null | undefined;
}): ArgEditSchemaResolverDeps['lookupOperation'] => {
  return (operationId: string): ResolvedOperationCatalogEntry | null => {
    const editable_args = readers.getEditableArgs?.(operationId) ?? undefined;
    const request_schema = readers.getRequestSchema?.(operationId);
    if (editable_args === undefined && request_schema === undefined) return null;
    return {
      ...(editable_args !== undefined ? { editable_args } : {}),
      ...(request_schema !== undefined ? { request_schema } : {}),
    };
  };
};
